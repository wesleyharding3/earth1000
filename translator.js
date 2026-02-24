// translator.js

require("dotenv").config(); // MUST be first

const deepl = require("deepl-node");

// Basic key presence check
if (!process.env.DEEPL_API_KEY) {
  throw new Error("❌ DEEPL_API_KEY is not set in environment!");
}

// Create translator using PRO endpoint
const translator = new deepl.Translator(
  process.env.DEEPL_API_KEY,
  { serverUrl: "https://api.deepl.com" } // Pro endpoint
);

console.log("✅ DeepL initialized (Pro endpoint)");

async function translateText(text, targetLang = "EN-US") {
  if (!text) return null;

  try {
    console.log(`🌍 Translating (${text.length} chars)`);

    const result = await translator.translateText(
      text,
      null,
      targetLang
    );

    console.log("✅ Translation success");
    return result.text;

  } catch (err) {
    console.error("❌ Translation error:", err.message);
    return null;
  }
}

module.exports = { translateText };