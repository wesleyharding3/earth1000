// ===============================
// fetcher.js (Production Version)
// ===============================

require("dotenv").config();

const Parser = require("rss-parser");
const pool = require("./db");

const parser = new Parser();

// ===============================
// DeepL Config
// ===============================

const DEEPL_API_KEY = process.env.DEEPL_API_KEY?.trim() || null;
const isFreeKey = DEEPL_API_KEY?.endsWith(":fx") === true;
const DEEPL_URL = isFreeKey
  ? "https://api-free.deepl.com/v2/translate"
  : "https://api.deepl.com/v2/translate";

let deeplDisabled = !DEEPL_API_KEY;

console.log("=== DeepL Config ===");
console.log("Key present:", !!DEEPL_API_KEY);
console.log("Key last 5 chars:", DEEPL_API_KEY?.slice(-5));
console.log("Is free key:", isFreeKey);
console.log("URL:", DEEPL_URL);

// ===============================
// Translation Helper
// ===============================

async function translateText(text, target = "EN") {
  if (!text || deeplDisabled) return null;

  try {
    const response = await fetch(DEEPL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        auth_key: DEEPL_API_KEY,
        text,
        target_lang: target
      })
    });

    if (response.status === 403) {
      console.error("❌ DeepL 403 Forbidden — disabling translations.");
      deeplDisabled = true;
      return null;
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.error("DeepL API error:", response.status, errorText);
      return null;
    }

    const data = await response.json();
    return data.translations?.[0]?.text || null;

  } catch (err) {
    console.error("Translation error:", err.message);
    return null;
  }
}

// ===============================
// Utility: Clean HTML
// ==========
