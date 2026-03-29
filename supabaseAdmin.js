'use strict';

const { createClient } = require('@supabase/supabase-js');

// Server-side only — uses service_role key which bypasses RLS.
// Never send SUPABASE_SERVICE_ROLE_KEY to the frontend.
const sba = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

module.exports = sba;
