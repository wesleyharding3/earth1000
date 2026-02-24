// translator.js
require("dotenv").config();
const deepl = require("deepl-node");  // import the package

// Create a translator instance
const translator = new deepl.Translator(process.env.DEEPL_API_KEY);

async function translateText(text, targetLang = "EN") {
  if (!text) return null;

  try {
    const result = await translator.translateText(text, null, targetLang);
    return result.text;
  } catch (err) {
    console.error("❌ Translation error:", err);
    return null;
  }
}

module.exports = { translateText };