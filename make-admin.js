#!/usr/bin/env node
'use strict';
require('dotenv').config();
const sba = require('./supabaseAdmin');

const EMAIL = process.argv[2] || 'wesleyharding3@gmail.com';

(async () => {
  // Find user by email
  const { data: { users }, error: listErr } = await sba.auth.admin.listUsers();
  if (listErr) { console.error('listUsers error:', listErr.message); process.exit(1); }

  const user = users.find(u => u.email === EMAIL);
  if (!user) {
    console.error(`No Supabase auth user found with email: ${EMAIL}`);
    process.exit(1);
  }
  console.log(`Found user: ${user.id} (${user.email})`);

  // Upsert profile with is_admin = true
  const { error } = await sba
    .from('profiles')
    .upsert({ id: user.id, is_admin: true }, { onConflict: 'id' });

  if (error) {
    console.error('Upsert error:', error.message);
    process.exit(1);
  }

  console.log(`✅ ${EMAIL} is now admin`);
  process.exit(0);
})();
