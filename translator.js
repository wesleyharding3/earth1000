require("dotenv").config();
const { DeepL } = require("deepl-node");

const deepl = new DeepL(process.env.DEEPL_API_KEY);

async function translateText(text, targetLang = "EN") {
  if (!text) return null;

  try {
    const result = await deepl.translateText(text, null, targetLang);
    return result.text;
  } catch (err) {
    console.error("❌ Translation error:", err);
    return null;
  }
}

module.exports = { translateText };