const express = require('express');
const router = express.Router();
const { query } = require('../db/connection');
const { createModuleLogger } = require('../utils/logger');

const log = createModuleLogger('routes.sync');

/**
 * Helper: Build a name → server_id lookup map for all categories.
 * For subcategories, the key is "ParentName::SubName" to handle
 * subcategories with the same name under different parents.
 */
async function buildCategoryNameMap() {
  const allCats = await query(`
    SELECT c.id, c.name, c.parent_id, p.name as parent_name
    FROM categories c
    LEFT JOIN categories p ON c.parent_id = p.id
    ORDER BY c.parent_id NULLS FIRST
  `);
  const nameMap = {};
  for (const cat of allCats.rows) {
    if (cat.parent_id) {
      // Subcategory: key = "ParentName::SubName"
      nameMap[`${cat.parent_name}::${cat.name}`] = cat.id;
    } else {
      // Parent: key = just the name
      nameMap[cat.name] = cat.id;
    }
  }
  return nameMap;
}

// POST /api/sync/push - Push data from mobile to VPS
router.post('/push', async (req, res) => {
  try {
    const { device_id, data } = req.body;

    if (!device_id || !data) {
      return res.status(400).json({ error: 'device_id and data required' });
    }

    const results = {
      transactions: { created: 0, updated: 0, errors: 0 },
      contacts: { created: 0, updated: 0, errors: 0 },
      classification_rules: { created: 0, updated: 0, errors: 0 },
      categories: { created: 0, updated: 0, errors: 0 },
      splits: { created: 0, updated: 0, errors: 0 }
    };

    // ─── 1. SYNC CATEGORIES FIRST (so we can resolve names for transactions) ───
    if (data.categories?.length > 0) {
      // Separate parents and children
      const parents = data.categories.filter(c => !c.parent_name && !c.parent_id);
      const children = data.categories.filter(c => c.parent_name || c.parent_id);

      // Upsert parent categories
      for (const cat of parents) {
        try {
          const existing = await query(
            'SELECT id FROM categories WHERE name = $1 AND parent_id IS NULL',
            [cat.name]
          );
          if (existing.rows.length > 0) {
            await query(
              'UPDATE categories SET icon = $1, is_active = $2, sort_order = $3, updated_at = NOW() WHERE id = $4',
              [cat.icon, cat.is_active !== false, cat.sort_order || 0, existing.rows[0].id]
            );
            results.categories.updated++;
          } else {
            await query(
              'INSERT INTO categories (name, icon, parent_id, is_active, sort_order) VALUES ($1, $2, NULL, $3, $4)',
              [cat.name, cat.icon, cat.is_active !== false, cat.sort_order || 0]
            );
            results.categories.created++;
          }
        } catch (err) {
          results.categories.errors++;
          log.warn('sync_cat_error', 'Failed to sync parent category', { name: cat.name, error: err.message });
        }
      }

      // Upsert child categories — resolve parent by name
      for (const cat of children) {
        try {
          const parentName = cat.parent_name;
          if (!parentName) {
            results.categories.errors++;
            continue;
          }

          // Look up parent by name
          const parentResult = await query(
            'SELECT id FROM categories WHERE name = $1 AND parent_id IS NULL',
            [parentName]
          );
          if (parentResult.rows.length === 0) {
            log.warn('sync_cat_orphan', `Parent "${parentName}" not found for sub "${cat.name}"`);
            results.categories.errors++;
            continue;
          }
          const serverParentId = parentResult.rows[0].id;

          const existing = await query(
            'SELECT id FROM categories WHERE name = $1 AND parent_id = $2',
            [cat.name, serverParentId]
          );
          if (existing.rows.length > 0) {
            await query(
              'UPDATE categories SET icon = $1, is_active = $2, sort_order = $3, updated_at = NOW() WHERE id = $4',
              [cat.icon, cat.is_active !== false, cat.sort_order || 0, existing.rows[0].id]
            );
            results.categories.updated++;
          } else {
            await query(
              'INSERT INTO categories (name, icon, parent_id, is_active, sort_order) VALUES ($1, $2, $3, $4, $5)',
              [cat.name, cat.icon, serverParentId, cat.is_active !== false, cat.sort_order || 0]
            );
            results.categories.created++;
          }
        } catch (err) {
          results.categories.errors++;
          log.warn('sync_cat_error', 'Failed to sync sub-category', { name: cat.name, error: err.message });
        }
      }
    }

    // Build name → id map AFTER categories are synced
    const catNameMap = await buildCategoryNameMap();

    // ─── 2. SYNC TRANSACTIONS ───
    if (data.transactions?.length > 0) {
      for (const tx of data.transactions) {
        try {
          // Resolve category/subcategory by name instead of raw IDs
          let serverCatId = null;
          let serverSubCatId = null;

          if (tx.category_name) {
            serverCatId = catNameMap[tx.category_name] || null;
          }
          if (tx.subcategory_name && tx.category_name) {
            serverSubCatId = catNameMap[`${tx.category_name}::${tx.subcategory_name}`] || null;
          }

          const result = await query(`
            INSERT INTO transactions (
              external_id, account_id, type, amount, transaction_date, description,
              merchant_name, upi_ref, contact_id, category_id, subcategory_id,
              is_classified, classification_method, classification_confidence,
              is_split, is_loan, loan_type, is_credit_card_repayment,
              special_flag, special_flag_note, notes, raw_sms, source,
              available_balance, available_credit_limit, synced_at
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
              $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, NOW()
            )
            ON CONFLICT (external_id) DO UPDATE SET
              -- CRITICAL: Only overwrite classification if incoming is classified
              -- This prevents a fresh phone SMS scan from wiping existing classifications
              category_id = CASE WHEN EXCLUDED.is_classified = true THEN COALESCE(EXCLUDED.category_id, transactions.category_id) ELSE transactions.category_id END,
              subcategory_id = CASE WHEN EXCLUDED.is_classified = true THEN COALESCE(EXCLUDED.subcategory_id, transactions.subcategory_id) ELSE transactions.subcategory_id END,
              is_classified = CASE WHEN EXCLUDED.is_classified = true THEN true ELSE transactions.is_classified END,
              classification_method = CASE WHEN EXCLUDED.is_classified = true THEN COALESCE(EXCLUDED.classification_method, transactions.classification_method) ELSE transactions.classification_method END,
              merchant_name = COALESCE(EXCLUDED.merchant_name, transactions.merchant_name),
              is_credit_card_repayment = CASE WHEN EXCLUDED.is_credit_card_repayment = true THEN true ELSE transactions.is_credit_card_repayment END,
              is_split = CASE WHEN EXCLUDED.is_split = true THEN true ELSE transactions.is_split END,
              is_loan = CASE WHEN EXCLUDED.is_loan = true THEN true ELSE transactions.is_loan END,
              loan_type = COALESCE(EXCLUDED.loan_type, transactions.loan_type),
              notes = COALESCE(EXCLUDED.notes, transactions.notes),
              special_flag = COALESCE(EXCLUDED.special_flag, transactions.special_flag),
              special_flag_note = COALESCE(EXCLUDED.special_flag_note, transactions.special_flag_note),
              synced_at = NOW(),
              updated_at = NOW()
            RETURNING id, (xmax = 0) as is_new
          `, [
            tx.external_id, tx.account_id, tx.type, tx.amount, tx.transaction_date,
            tx.description, tx.merchant_name, tx.upi_ref, null,
            serverCatId, serverSubCatId, tx.is_classified || false,
            tx.classification_method, tx.classification_confidence,
            tx.is_split || false, tx.is_loan || false, tx.loan_type,
            tx.is_credit_card_repayment || false, tx.special_flag, tx.special_flag_note,
            tx.notes, tx.raw_sms, tx.source || 'sms',
            tx.available_balance, tx.available_credit_limit
          ]);

          if (result.rows[0].is_new) results.transactions.created++;
          else results.transactions.updated++;
        } catch (err) {
          results.transactions.errors++;
          if (results.transactions.errors <= 5) {
            log.warn('sync_tx_error', 'Failed to sync transaction', {
              externalId: tx.external_id,
              error: err.message
            });
          }
        }
      }
    }

    // ─── 3. SYNC CONTACTS (skip errors silently — contacts are auto-extracted from SMS) ───
    if (data.contacts?.length > 0) {
      for (const contact of data.contacts) {
        try {
          // Try to find existing by name
          const existing = await query(
            'SELECT id FROM contacts WHERE name = $1',
            [contact.name]
          );
          if (existing.rows.length > 0) {
            results.contacts.updated++;
          } else {
            await query(
              'INSERT INTO contacts (name, type, relationship, notes) VALUES ($1, $2, $3, $4)',
              [contact.name, contact.type || 'merchant', contact.relationship, contact.notes]
            );
            results.contacts.created++;
          }
        } catch (err) {
          results.contacts.errors++;
        }
      }
    }

    // ─── 4. SYNC CLASSIFICATION RULES ───
    if (data.classification_rules?.length > 0) {
      for (const rule of data.classification_rules) {
        try {
          // Resolve category by name
          let serverCatId = null;
          let serverSubCatId = null;
          if (rule.category_name) {
            serverCatId = catNameMap[rule.category_name] || null;
          }
          if (rule.subcategory_name && rule.category_name) {
            serverSubCatId = catNameMap[`${rule.category_name}::${rule.subcategory_name}`] || null;
          }

          await query(`
            INSERT INTO classification_rules (match_type, match_value, category_id, subcategory_id, confidence, hit_count)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (match_type, match_value) DO UPDATE SET
              category_id = COALESCE(EXCLUDED.category_id, classification_rules.category_id),
              subcategory_id = COALESCE(EXCLUDED.subcategory_id, classification_rules.subcategory_id),
              confidence = GREATEST(classification_rules.confidence, EXCLUDED.confidence),
              hit_count = GREATEST(classification_rules.hit_count, EXCLUDED.hit_count),
              updated_at = NOW()
          `, [rule.match_type, rule.match_value, serverCatId, serverSubCatId, rule.confidence || 0.5, rule.hit_count || 1]);

          results.classification_rules.created++;
        } catch (err) {
          results.classification_rules.errors++;
        }
      }
    }

    // ─── 5. SYNC SPLITS ───
    if (data.splits?.length > 0) {
      for (const split of data.splits) {
        try {
          // Find the server transaction ID by external_id
          let serverTxId = null;
          if (split.transaction_external_id) {
            const txResult = await query('SELECT id FROM transactions WHERE external_id = $1', [split.transaction_external_id]);
            if (txResult.rows.length > 0) serverTxId = txResult.rows[0].id;
          }
          if (!serverTxId) {
            results.splits.errors++;
            continue;
          }

          // Upsert split
          const splitResult = await query(`
            INSERT INTO splits (transaction_id, total_amount, my_share, is_fully_settled, notes)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (transaction_id) DO UPDATE SET
              total_amount = EXCLUDED.total_amount,
              my_share = EXCLUDED.my_share,
              is_fully_settled = EXCLUDED.is_fully_settled,
              notes = EXCLUDED.notes,
              updated_at = NOW()
            RETURNING id
          `, [serverTxId, split.total_amount, split.my_share, split.is_fully_settled || false, split.notes]);

          const serverSplitId = splitResult.rows[0].id;

          // Upsert participants
          if (split.participants?.length > 0) {
            for (const p of split.participants) {
              await query(`
                INSERT INTO split_participants (split_id, contact_name, amount, is_settled, settled_at)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT DO NOTHING
              `, [serverSplitId, p.contact_name, p.amount, p.is_settled || false, p.settled_at]);
            }
          }
          results.splits.created++;
        } catch (err) {
          results.splits.errors++;
          log.warn('sync_split_error', 'Failed to sync split', { error: err.message });
        }
      }
    }

    // Log sync
    await query(`
      INSERT INTO sync_log (device_id, table_name, last_sync_at, records_synced, direction, status)
      VALUES ($1, 'all', NOW(), $2, 'push', 'success')
    `, [device_id, (data.transactions?.length || 0) + (data.contacts?.length || 0) + (data.categories?.length || 0) + (data.splits?.length || 0)]);

    log.info('push_complete', 'Sync push completed', { device_id, results });
    res.json({ message: 'Sync complete', results });
  } catch (err) {
    log.error('push_error', 'Sync push failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/sync/pull - Pull data from VPS to mobile
router.post('/pull', async (req, res) => {
  try {
    const { device_id, last_sync_at } = req.body;

    if (!device_id) {
      return res.status(400).json({ error: 'device_id required' });
    }

    const since = last_sync_at || '1970-01-01';

    // Pull categories with parent_name for client-side resolution
    const categories = await query(`
      SELECT c.*, p.name as parent_name
      FROM categories c
      LEFT JOIN categories p ON c.parent_id = p.id
      WHERE c.updated_at > $1
      ORDER BY c.parent_id NULLS FIRST, c.sort_order
    `, [since]);

    // Pull transactions with category/subcategory names for client-side resolution
    const transactions = await query(`
      SELECT t.*, 
        cat.name as category_name,
        subcat.name as subcategory_name
      FROM transactions t
      LEFT JOIN categories cat ON t.category_id = cat.id
      LEFT JOIN categories subcat ON t.subcategory_id = subcat.id
      WHERE t.updated_at > $1 
      ORDER BY t.updated_at 
      LIMIT 1000
    `, [since]);

    const contacts = await query(
      'SELECT * FROM contacts WHERE updated_at > $1 ORDER BY updated_at',
      [since]
    );

    // Pull classification rules with category names
    const rules = await query(`
      SELECT cr.*, 
        cat.name as category_name,
        subcat.name as subcategory_name
      FROM classification_rules cr
      LEFT JOIN categories cat ON cr.category_id = cat.id
      LEFT JOIN categories subcat ON cr.subcategory_id = subcat.id
      WHERE cr.updated_at > $1 
      ORDER BY cr.updated_at
    `, [since]);

    const accounts = await query(
      'SELECT * FROM accounts WHERE updated_at > $1 ORDER BY updated_at',
      [since]
    );

    // Pull splits with participant data and transaction external_id
    const splits = await query(`
      SELECT s.*, t.external_id as transaction_external_id
      FROM splits s
      JOIN transactions t ON s.transaction_id = t.id
      WHERE s.updated_at > $1
      ORDER BY s.updated_at
    `, [since]);

    // Pull split participants for those splits
    const splitIds = splits.rows.map(s => s.id);
    let splitParticipants = { rows: [] };
    if (splitIds.length > 0) {
      const placeholders = splitIds.map((_, i) => `$${i + 1}`).join(',');
      splitParticipants = await query(
        `SELECT * FROM split_participants WHERE split_id IN (${placeholders})`,
        splitIds
      );
    }

    // Attach participants to their splits
    const splitsWithParticipants = splits.rows.map(s => ({
      ...s,
      participants: splitParticipants.rows.filter(p => p.split_id === s.id)
    }));

    // Log sync
    await query(`
      INSERT INTO sync_log (device_id, table_name, last_sync_at, records_synced, direction, status)
      VALUES ($1, 'all', NOW(), $2, 'pull', 'success')
    `, [device_id, transactions.rowCount + categories.rowCount + contacts.rowCount + splits.rowCount]);

    log.info('pull_complete', 'Sync pull completed', {
      device_id,
      transactions: transactions.rowCount,
      categories: categories.rowCount,
      contacts: contacts.rowCount,
      rules: rules.rowCount,
      splits: splits.rowCount
    });

    res.json({
      transactions: transactions.rows,
      categories: categories.rows,
      contacts: contacts.rows,
      classification_rules: rules.rows,
      accounts: accounts.rows,
      splits: splitsWithParticipants,
      synced_at: new Date().toISOString()
    });
  } catch (err) {
    log.error('pull_error', 'Sync pull failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/sync/status - Get sync status
router.get('/status', async (req, res) => {
  try {
    const { device_id } = req.query;

    const result = await query(`
      SELECT * FROM sync_log
      WHERE device_id = $1
      ORDER BY created_at DESC
      LIMIT 10
    `, [device_id || 'unknown']);

    res.json(result.rows);
  } catch (err) {
    log.error('status_error', 'Failed to get sync status', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
