const express = require('express');
const router = express.Router();
const { query } = require('../db/connection');
const { createModuleLogger } = require('../utils/logger');

const log = createModuleLogger('routes.transactions');

// GET /api/transactions - List transactions with filters
router.get('/', async (req, res) => {
  try {
    const {
      account_id, category_id, is_classified, is_split, is_loan,
      type, source, date_from, date_to,
      limit = 50, offset = 0, sort = 'transaction_date', order = 'DESC'
    } = req.query;

    let sql = `
      SELECT t.*,
             a.name as account_name, a.type as account_type,
             c.name as category_name, c.icon as category_icon,
             sc.name as subcategory_name,
             co.name as contact_name
      FROM transactions t
      LEFT JOIN accounts a ON t.account_id = a.id
      LEFT JOIN categories c ON t.category_id = c.id
      LEFT JOIN categories sc ON t.subcategory_id = sc.id
      LEFT JOIN contacts co ON t.contact_id = co.id
      WHERE 1=1
    `;
    const params = [];
    let paramIdx = 1;

    if (account_id) { sql += ` AND t.account_id = $${paramIdx++}`; params.push(account_id); }
    if (category_id) { sql += ` AND t.category_id = $${paramIdx++}`; params.push(category_id); }
    if (is_classified !== undefined) { sql += ` AND t.is_classified = $${paramIdx++}`; params.push(is_classified === 'true'); }
    if (is_split !== undefined) { sql += ` AND t.is_split = $${paramIdx++}`; params.push(is_split === 'true'); }
    if (is_loan !== undefined) { sql += ` AND t.is_loan = $${paramIdx++}`; params.push(is_loan === 'true'); }
    if (type) { sql += ` AND t.type = $${paramIdx++}`; params.push(type); }
    if (source) { sql += ` AND t.source = $${paramIdx++}`; params.push(source); }
    if (date_from) { sql += ` AND t.transaction_date >= $${paramIdx++}`; params.push(date_from); }
    if (date_to) { sql += ` AND t.transaction_date <= $${paramIdx++}`; params.push(date_to); }

    // Whitelist sort columns
    const allowedSorts = ['transaction_date', 'amount', 'created_at', 'merchant_name'];
    const sortCol = allowedSorts.includes(sort) ? sort : 'transaction_date';
    const sortDir = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    sql += ` ORDER BY t.${sortCol} ${sortDir}`;
    sql += ` LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await query(sql, params);

    // Get total count
    let countSql = 'SELECT COUNT(*) FROM transactions t WHERE 1=1';
    const countParams = [];
    let countIdx = 1;
    if (account_id) { countSql += ` AND t.account_id = $${countIdx++}`; countParams.push(account_id); }
    if (is_classified !== undefined) { countSql += ` AND t.is_classified = $${countIdx++}`; countParams.push(is_classified === 'true'); }
    const countResult = await query(countSql, countParams);

    res.json({
      transactions: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (err) {
    log.error('list_error', 'Failed to list transactions', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/transactions/:id - Single transaction
router.get('/:id', async (req, res) => {
  try {
    const result = await query(`
      SELECT t.*,
             a.name as account_name,
             c.name as category_name, c.icon as category_icon,
             sc.name as subcategory_name,
             co.name as contact_name
      FROM transactions t
      LEFT JOIN accounts a ON t.account_id = a.id
      LEFT JOIN categories c ON t.category_id = c.id
      LEFT JOIN categories sc ON t.subcategory_id = sc.id
      LEFT JOIN contacts co ON t.contact_id = co.id
      WHERE t.id = $1
    `, [req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Transaction not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    log.error('get_error', 'Failed to get transaction', { error: err.message, id: req.params.id });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/transactions - Create transaction
router.post('/', async (req, res) => {
  try {
    const {
      external_id, account_id, type, amount, transaction_date, description,
      merchant_name, upi_ref, contact_id, category_id, subcategory_id,
      is_classified, classification_method, classification_confidence,
      is_split, is_loan, loan_type, is_credit_card_repayment,
      special_flag, special_flag_note, notes, raw_sms, source,
      available_balance, available_credit_limit
    } = req.body;

    const result = await query(`
      INSERT INTO transactions (
        external_id, account_id, type, amount, transaction_date, description,
        merchant_name, upi_ref, contact_id, category_id, subcategory_id,
        is_classified, classification_method, classification_confidence,
        is_split, is_loan, loan_type, is_credit_card_repayment,
        special_flag, special_flag_note, notes, raw_sms, source,
        available_balance, available_credit_limit
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
        $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25
      )
      ON CONFLICT (external_id) DO UPDATE SET
        updated_at = NOW(),
        category_id = COALESCE(EXCLUDED.category_id, transactions.category_id),
        subcategory_id = COALESCE(EXCLUDED.subcategory_id, transactions.subcategory_id),
        is_classified = COALESCE(EXCLUDED.is_classified, transactions.is_classified),
        contact_id = COALESCE(EXCLUDED.contact_id, transactions.contact_id)
      RETURNING *
    `, [
      external_id, account_id, type, amount, transaction_date, description,
      merchant_name, upi_ref, contact_id, category_id, subcategory_id,
      is_classified || false, classification_method, classification_confidence,
      is_split || false, is_loan || false, loan_type, is_credit_card_repayment || false,
      special_flag, special_flag_note, notes, raw_sms, source || 'sms',
      available_balance, available_credit_limit
    ]);

    log.info('created', 'Transaction created', {
      id: result.rows[0].id,
      type,
      amount,
      merchant: merchant_name,
      source
    });

    res.status(201).json(result.rows[0]);
  } catch (err) {
    log.error('create_error', 'Failed to create transaction', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/transactions/:id - Update transaction
router.put('/:id', async (req, res) => {
  try {
    const fields = req.body;
    const setClauses = [];
    const params = [];
    let paramIdx = 1;

    const allowed = [
      'category_id', 'subcategory_id', 'contact_id', 'is_classified',
      'classification_method', 'classification_confidence', 'is_split',
      'is_loan', 'loan_type', 'is_credit_card_repayment', 'special_flag',
      'special_flag_note', 'notes', 'merchant_name', 'description'
    ];

    for (const field of allowed) {
      if (fields[field] !== undefined) {
        setClauses.push(`${field} = $${paramIdx++}`);
        params.push(fields[field]);
      }
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    setClauses.push(`updated_at = NOW()`);
    params.push(req.params.id);

    const result = await query(
      `UPDATE transactions SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    log.info('updated', 'Transaction updated', { id: req.params.id, fields: Object.keys(fields) });
    res.json(result.rows[0]);
  } catch (err) {
    log.error('update_error', 'Failed to update transaction', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/transactions/:id - Delete transaction
router.delete('/:id', async (req, res) => {
  try {
    // Delete split participants first (foreign key constraints)
    await query('DELETE FROM split_participants WHERE split_id IN (SELECT id FROM splits WHERE transaction_id = $1)', [req.params.id]);
    await query('DELETE FROM splits WHERE transaction_id = $1', [req.params.id]);
    const result = await query('DELETE FROM transactions WHERE id = $1 RETURNING *', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Transaction not found' });
    }
    log.info('deleted', 'Transaction deleted', { id: req.params.id });
    res.json({ success: true, transaction: result.rows[0] });
  } catch (err) {
    log.error('delete_error', 'Failed to delete transaction', { error: err.message, id: req.params.id });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/transactions/delete-bulk - Bulk delete transactions by ID or external_id
router.post('/delete-bulk', async (req, res) => {
  try {
    const { ids, external_ids } = req.body;
    if (!Array.isArray(ids) && !Array.isArray(external_ids)) {
      return res.status(400).json({ error: 'ids or external_ids array required' });
    }

    let deletedCount = 0;
    if (Array.isArray(ids) && ids.length > 0) {
      // split participants
      await query('DELETE FROM split_participants WHERE split_id IN (SELECT id FROM splits WHERE transaction_id = ANY($1))', [ids]);
      await query('DELETE FROM splits WHERE transaction_id = ANY($1)', [ids]);
      const resDel = await query('DELETE FROM transactions WHERE id = ANY($1) RETURNING id', [ids]);
      deletedCount += resDel.rowCount;
    }
    if (Array.isArray(external_ids) && external_ids.length > 0) {
      // split participants
      await query('DELETE FROM split_participants WHERE split_id IN (SELECT id FROM splits WHERE transaction_id IN (SELECT id FROM transactions WHERE external_id = ANY($1)))', [external_ids]);
      await query('DELETE FROM splits WHERE transaction_id IN (SELECT id FROM transactions WHERE external_id = ANY($1))', [external_ids]);
      const resDel = await query('DELETE FROM transactions WHERE external_id = ANY($1) RETURNING id', [external_ids]);
      deletedCount += resDel.rowCount;
    }

    log.info('bulk_deleted', 'Transactions bulk deleted', { count: deletedCount });
    res.json({ success: true, count: deletedCount });
  } catch (err) {
    log.error('bulk_delete_error', 'Failed to bulk delete transactions', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/transactions/bulk - Bulk create/upsert (for sync)
router.post('/bulk', async (req, res) => {
  try {
    const { transactions } = req.body;
    if (!Array.isArray(transactions) || transactions.length === 0) {
      return res.status(400).json({ error: 'transactions array required' });
    }

    const results = { created: 0, updated: 0, errors: [] };

    for (const tx of transactions) {
      try {
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
            updated_at = NOW(),
            synced_at = NOW(),
            category_id = COALESCE(EXCLUDED.category_id, transactions.category_id),
            subcategory_id = COALESCE(EXCLUDED.subcategory_id, transactions.subcategory_id),
            is_classified = COALESCE(EXCLUDED.is_classified, transactions.is_classified),
            contact_id = COALESCE(EXCLUDED.contact_id, transactions.contact_id),
            is_split = COALESCE(EXCLUDED.is_split, transactions.is_split),
            is_loan = COALESCE(EXCLUDED.is_loan, transactions.is_loan),
            notes = COALESCE(EXCLUDED.notes, transactions.notes)
          RETURNING id, (xmax = 0) as is_new
        `, [
          tx.external_id, tx.account_id, tx.type, tx.amount, tx.transaction_date,
          tx.description, tx.merchant_name, tx.upi_ref, tx.contact_id,
          tx.category_id, tx.subcategory_id, tx.is_classified || false,
          tx.classification_method, tx.classification_confidence,
          tx.is_split || false, tx.is_loan || false, tx.loan_type,
          tx.is_credit_card_repayment || false, tx.special_flag, tx.special_flag_note,
          tx.notes, tx.raw_sms, tx.source || 'sms',
          tx.available_balance, tx.available_credit_limit
        ]);

        if (result.rows[0].is_new) {
          results.created++;
        } else {
          results.updated++;
        }
      } catch (err) {
        results.errors.push({ external_id: tx.external_id, error: err.message });
      }
    }

    log.info('bulk_sync', 'Bulk transaction sync completed', results);
    res.json(results);
  } catch (err) {
    log.error('bulk_error', 'Bulk sync failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/transactions/summary/monthly - Monthly summary
router.get('/summary/monthly', async (req, res) => {
  try {
    const { year, month, account_id } = req.query;

    let dateFilter = '';
    const params = [];
    let paramIdx = 1;

    if (year && month) {
      dateFilter = `AND EXTRACT(YEAR FROM transaction_date) = $${paramIdx++}
                     AND EXTRACT(MONTH FROM transaction_date) = $${paramIdx++}`;
      params.push(year, month);
    }
    if (account_id) {
      dateFilter += ` AND account_id = $${paramIdx++}`;
      params.push(account_id);
    }

    const result = await query(`
      SELECT
        c.name as category_name,
        c.icon as category_icon,
        SUM(CASE WHEN t.type IN ('debit', 'cc_spend') AND NOT t.is_credit_card_repayment AND NOT t.is_loan THEN t.amount ELSE 0 END) as total_spent,
        COUNT(CASE WHEN t.type IN ('debit', 'cc_spend') THEN 1 END) as transaction_count,
        SUM(CASE WHEN t.type = 'credit' AND NOT t.is_loan THEN t.amount ELSE 0 END) as total_income
      FROM transactions t
      LEFT JOIN categories c ON t.category_id = c.id
      WHERE t.is_classified = true ${dateFilter}
      GROUP BY c.id, c.name, c.icon
      ORDER BY total_spent DESC
    `, params);

    // Also get totals
    const totals = await query(`
      SELECT
        SUM(CASE WHEN type IN ('debit', 'cc_spend') AND NOT is_credit_card_repayment AND NOT is_loan THEN amount ELSE 0 END) as total_expenses,
        SUM(CASE WHEN type = 'credit' AND NOT is_loan THEN amount ELSE 0 END) as total_income,
        COUNT(*) as total_transactions,
        COUNT(CASE WHEN NOT is_classified THEN 1 END) as unclassified_count
      FROM transactions
      WHERE 1=1 ${dateFilter}
    `, params);

    res.json({
      categories: result.rows,
      totals: totals.rows[0]
    });
  } catch (err) {
    log.error('summary_error', 'Failed to get monthly summary', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
