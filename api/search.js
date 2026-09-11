export default async function handler(req, res) {
  const token = process.env.TMDB_READ_ACCESS_TOKEN;
  const { q, type, id, from, to } = req.query;
  if (!token) {
    return res.status(500).json({
      error: "TMDB token is not configured."
    });
  }
  const tmdb = async (endpoint) => {
    const response = await fetch(
      `https://api.themoviedb.org/3${endpoint}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          accept: "application/json"
        }
      }
    );
    if (!response.ok) {
      throw new Error(`TMDB request failed: ${response.status}`);
    }
    return response.json();
  };
  try {
    // ============================================================
    // SIX DEGREES
    // ============================================================
    if (type === "degrees") {
      if (!from || !to) {
        return res.status(400).json({
          error: "Two actors are required."
        });
      }
      // ----------------------------------------------------------
      // Find actors
      // ----------------------------------------------------------
      async function findActor(name) {
        const data = await tmdb(
          `/search/person?query=${encodeURIComponent(
            name.trim()
          )}&include_adult=false&language=en-US&page=1`
        );
        const results = data.results || [];
        const exact = results.find(
          p =>
            p.name &&
            p.name.toLowerCase() ===
              name.trim().toLowerCase()
        );
        const actor =
          exact ||
          results.find(
            p =>
              p.known_for_department === "Acting"
          );
        if (!actor) {
          throw new Error(
            `Actor not found: ${name}`
          );
        }
        return {
          id: actor.id,
          name: actor.name
        };
      }
      const [actorA, actorB] = await Promise.all([
        findActor(from),
        findActor(to)
      ]);
      // ----------------------------------------------------------
      // Get movie credits
      // ----------------------------------------------------------
      async function getMovies(personId) {
        const data = await tmdb(
          `/person/${personId}/movie_credits?language=en-US`
        );
        return (data.cast || [])
          .filter(movie => {
            if (!movie.id || !movie.title) {
              return false;
            }
            const character =
              String(movie.character || "")
                .trim()
                .toLowerCase();
            if (!character) {
              return false;
            }
            if (
              character === "self" ||
              character === "himself" ||
              character === "herself" ||
              character === "themselves"
            ) {
              return false;
            }
            if (
              character.includes("archive footage") ||
              character.includes("archival footage")
            ) {
              return false;
            }
            return true;
          })
          .map(movie => ({
            id: movie.id,
            title: movie.title,
            year: (movie.release_date || "").slice(0, 4),
            character: movie.character || ""
          }));
      }
      const [moviesA, moviesB] = await Promise.all([
        getMovies(actorA.id),
        getMovies(actorB.id)
      ]);
      // ----------------------------------------------------------
      // DIRECT CONNECTION
      //
      // This should immediately find:
      // Tom Cruise → Mission: Impossible - Fallout
      // → Michelle Monaghan
      // ----------------------------------------------------------
      const moviesBById = new Map();
      for (const movie of moviesB) {
        moviesBById.set(
          String(movie.id),
          movie
        );
      }
      let sharedMovie = null;
      for (const movie of moviesA) {
        if (
          moviesBById.has(
            String(movie.id)
          )
        ) {
          sharedMovie = movie;
          break;
        }
      }
      // ----------------------------------------------------------
      // DIRECT MATCH FOUND
      // ----------------------------------------------------------
      if (sharedMovie) {
        return res.status(200).json({
          from: actorA,
          to: actorB,
          distance: 1,
          path: [
            {
              person: actorA,
              movie: null
            },
            {
              person: actorB,
              movie: {
                id: sharedMovie.id,
                title: sharedMovie.title,
                year: sharedMovie.year
              }
            }
          ]
        });
      }
      // ----------------------------------------------------------
      // FALLBACK: match movie titles
      // ----------------------------------------------------------
      const normalizeTitle = title =>
        String(title || "")
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "");
      const titlesB = new Map();
      for (const movie of moviesB) {
        titlesB.set(
          normalizeTitle(movie.title),
          movie
        );
      }
      for (const movie of moviesA) {
        const key = normalizeTitle(movie.title);
        if (titlesB.has(key)) {
          return res.status(200).json({
            from: actorA,
            to: actorB,
            distance: 1,
            path: [
              {
                person: actorA,
                movie: null
              },
              {
                person: actorB,
                movie: {
                  id: movie.id,
                  title: movie.title,
                  year: movie.year
                }
              }
            ]
          });
        }
      }
      // ----------------------------------------------------------
      // NO DIRECT CONNECTION
      //
      // For now, return a clean result instead of making the
      // website hang while doing hundreds of TMDB requests.
      //
      // We will expand this into the full six-degree search
      // after the basic connection is working.
      // ----------------------------------------------------------
      return res.status(404).json({
        error:
          "No direct movie connection found.",
        path: []
      });
    }
    // ============================================================
    // NORMAL REELWISE SEARCH
    // ============================================================
    let endpoint;
    if (type === "movie" && id) {
      endpoint =
        `/movie/${id}` +
        `?language=en-US` +
        `&append_to_response=credits`;
    } else if (type === "person" && id) {
      endpoint =
        `/person/${id}` +
        `?language=en-US` +
        `&append_to_response=combined_credits`;
    } else if (q) {
      endpoint =
        `/search/multi?query=${encodeURIComponent(q)}` +
        `&include_adult=false` +
        `&language=en-US&page=1`;
    } else {
      return res.status(400).json({
        error: "Missing search query."
      });
    }
    const data = await tmdb(endpoint);
    return res.status(200).json(data);
  } catch (error) {
    console.error("REELWISE ERROR:", error);
    return res.status(500).json({
      error:
        error.message ||
        "Reelwise encountered an error."
    });
  }
}
