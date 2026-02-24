// translator.js
console.log("DEEPL_API_KEY =", process.env.DEEPL_API_KEY ? "✅ set" : "❌ missing");
require("dotenv").config();
const deepl = require("deepl-node");  // import the package

console.log("DEEPL_API_KEY =", process.env.DEEPL_API_KEY); // <-- debug

if (!process.env.DEEPL_API_KEY) {
  throw new Error("❌ DEEPL_API_KEY is not set in environment!");
}


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