const { Pool } = require("pg");

const pool = new Pool({
  user: "postgres",
  host: "localhost",
  database: "Earth1000",
  password: "117s8ukz",
  port: 5432,
});

module.exports = pool;
