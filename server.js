// ===============================
// GET NEWS BY CITY
// ===============================
app.get("/api/news/city/:cityId", async (req, res) => {
  try {
    const { cityId } = req.params;

    const result = await pool.query(
      `
      SELECT 
        a.id,
        a.title,
        a.url,
        a.summary,
        a.published_at,
        s.name AS source_name,
        s.site_url
      FROM news_articles a
      JOIN news_sources s ON a.source_id = s.id
      WHERE a.primary_city_id = $1
      ORDER BY a.published_at DESC
      LIMIT 20
      `,
      [cityId]
    );

    res.json(result.rows);

  } catch (err) {
    console.error("City news error:", err.message);
    res.status(500).json({ error: "Failed to fetch city news" });
  }
});
