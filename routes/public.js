const router = require('express').Router();
const supabase = require('../lib/supabase');

// Public settings (classes, subjects, languages) — no auth required for dropdowns
router.get('/settings', async (req, res) => {
  try {
    const [classes, subjects, languages] = await Promise.all([
      supabase.from('classes').select('id, name, sort_order').order('sort_order'),
      supabase.from('subjects').select('id, name, emoji').order('name'),
      supabase.from('languages').select('id, name, flag').order('name')
    ]);
    res.json({ classes: classes.data, subjects: subjects.data, languages: languages.data });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
