export default async function handler(req, res) {
  const token = process.env.TMDB_READ_ACCESS_TOKEN;

  if (!token) {
    return res.status(500).json({
      error: "TMDB API token is not configured."
    });
  }

  const { q, type, id, from, to } = req.query;

  async function tmdb(endpoint) {
    const response = await fetch(
      `https://api.themoviedb.org/3${endpoint}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        }
      }
    );

    if (!response.ok) {
      throw new Error(`TMDB request failed: ${response.status}`);
    }

    return response.json();
  }

  function clean(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  }

  async function findActor(name) {
    const data = await tmdb(
      `/search/person?query=${encodeURIComponent(name)}&language=en-US`
    );

    const results = data.results || [];

    if (!results.length) {
      return null;
    }

    const exact = results.find(
      person =>
        person.name &&
        person.name.toLowerCase() === name.toLowerCase()
    );

    return exact || results[0];
  }

  async function getMovieCredits(personId) {
    const data = await tmdb(
      `/person/${personId}/movie_credits?language=en-US`
    );

    return (data.cast || []).filter(movie => {
      const character = String(
        movie.character || ""
      ).toLowerCase();

      if (!character) return false;

      if (
        character.includes("self") ||
        character.includes("archive")
      ) {
        return false;
      }

      return true;
    });
  }

  function findSharedMovie(creditsA, creditsB) {
    const movieIds = new Set(
      creditsB.map(movie => movie.id)
    );

    const direct = creditsA.find(movie =>
      movieIds.has(movie.id)
    );

    if (direct) {
      return direct;
    }

    const movieTitles = new Set(
      creditsB.map(movie => clean(movie.title))
    );

    return (
      creditsA.find(movie =>
        movieTitles.has(clean(movie.title))
      ) || null
    );
  }

  /*
   * SIX DEGREES
   *
   * For now we establish the direct connection
   * using TMDB's official movie credits.
   */

  if (type === "degrees") {
    try {
      if (!from || !to) {
        return res.status(400).json({
          error: "Enter two actors."
        });
      }

      const [actorA, actorB] = await Promise.all([
        findActor(from),
        findActor(to)
      ]);

      if (!actorA) {
        return res.status(404).json({
          error: `Actor "${from}" was not found.`
        });
      }

      if (!actorB) {
        return res.status(404).json({
          error: `Actor "${to}" was not found.`
        });
      }

      if (actorA.id === actorB.id) {
        return res.status(400).json({
          error: "Choose two different actors."
        });
      }

      const [creditsA, creditsB] = await Promise.all([
        getMovieCredits(actorA.id),
        getMovieCredits(actorB.id)
      ]);

      const sharedMovie = findSharedMovie(
        creditsA,
        creditsB
      );

      if (sharedMovie) {
        return res.status(200).json({
          from: {
            id: actorA.id,
            name: actorA.name
          },

          to: {
            id: actorB.id,
            name: actorB.name
          },

          distance: 1,

          path: [
            {
              person: {
                id: actorA.id,
                name: actorA.name
              }
            },

            {
              person: {
                id: actorB.id,
                name: actorB.name
              },

              movie: {
                id: sharedMovie.id,
                title: sharedMovie.title,
                year: sharedMovie.release_date
                  ? sharedMovie.release_date.substring(0, 4)
                  : ""
              }
            }
          ]
        });
      }

      return res.status(404).json({
        error:
          `No direct movie connection found between ${actorA.name} and ${actorB.name}.`
      });

    } catch (error) {
      console.error("Six Degrees error:", error);

      return res.status(500).json({
        error: error.message || "Six Degrees search failed."
      });
    }
  }

  /*
   * NORMAL REELWISE SEARCH
   */

  try {
    if (type === "movie") {
      return res.status(200).json(
        await tmdb(
          `/search/movie?query=${encodeURIComponent(
            q || ""
          )}&language=en-US`
        )
      );
    }

    if (type === "person") {
      return res.status(200).json(
        await tmdb(
          `/search/person?query=${encodeURIComponent(
            q || ""
          )}&language=en-US`
        )
      );
    }

    if (type === "movie-details") {
      return res.status(200).json(
        await tmdb(
          `/movie/${id}?language=en-US&append_to_response=credits`
        )
      );
    }

    if (type === "person-details") {
      return res.status(200).json(
        await tmdb(
          `/person/${id}?language=en-US&append_to_response=combined_credits`
        )
      );
    }

    return res.status(200).json(
      await tmdb(
        `/search/multi?query=${encodeURIComponent(
          q || ""
        )}&language=en-US`
      )
    );

  } catch (error) {
    console.error("Reelwise search error:", error);

    return res.status(500).json({
      error: "Search failed."
    });
  }
}
