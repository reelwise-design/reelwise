export default async function handler(req, res) {
  const token = process.env.TMDB_READ_ACCESS_TOKEN;
  const { q, type, id } = req.query;

  if (!token) {
    return res.status(500).json({ error: "TMDB token is not configured" });
  }

  try {
    let url;

    if (type === "movie" && id) {
      url = `https://api.themoviedb.org/3/movie/${id}?language=en-US&append_to_response=credits`;
    } else if (type === "person" && id) {
      url = `https://api.themoviedb.org/3/person/${id}?language=en-US&append_to_response=combined_credits`;
    } else if (q) {
      url = `https://api.themoviedb.org/3/search/multi?query=${encodeURIComponent(q)}&include_adult=false&language=en-US&page=1`;
    } else {
      return res.status(400).json({ error: "Missing search query or ID" });
    }

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        accept: "application/json"
      }
    });

    if (!response.ok) {
      return res.status(response.status).json({
        error: "TMDB request failed"
      });
    }

    const data = await response.json();

    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({
      error: "Unable to connect to TMDB"
    });
  }
}
