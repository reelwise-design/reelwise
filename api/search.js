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

  async function findActor(name) {
    const data = await tmdb(
      `/search/person?query=${encodeURIComponent(name)}&language=en-US`
    );

    if (!data.results || data.results.length === 0) {
      return null;
    }

    const exact = data.results.find(
      person =>
        person.name &&
        person.name.toLowerCase() === name.toLowerCase()
    );

    return exact || data.results[0];
  }

  function realActingCredit(credit) {
    if (!credit) return false;

    const character = String(credit.character || "").toLowerCase();

    if (!character) return false;

    const badCredits = [
      "self",
      "himself",
      "herself",
      "themselves",
      "archive footage",
      "archive"
    ];

    return !badCredits.some(word => character.includes(word));
  }

  function movieData(movie) {
    return {
      id: movie.id,
      title: movie.title,
      year: movie.release_date
        ? movie.release_date.substring(0, 4)
        : ""
    };
  }

  /*
   * =========================================================
   * SIX DEGREES
   * =========================================================
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

      /*
       * Get both actors' movie credits AT THE SAME TIME.
       * This is much faster than checking movies one at a time.
       */

      const [creditsAData, creditsBData] = await Promise.all([
        tmdb(`/person/${actorA.id}/movie_credits?language=en-US`),
        tmdb(`/person/${actorB.id}/movie_credits?language=en-US`)
      ]);

      const creditsA = (creditsAData.cast || [])
        .filter(realActingCredit);

      const creditsB = (creditsBData.cast || [])
        .filter(realActingCredit);

      /*
       * Create a lookup table for Actor B's movies.
       */

      const moviesB = new Map();

      for (const movie of creditsB) {
        moviesB.set(movie.id, movie);
      }

      /*
       * Find movies shared by both actors.
       */

      const sharedMovies = creditsA
        .filter(movie => moviesB.has(movie.id))
        .map(movie => ({
          movie,
          other: moviesB.get(movie.id)
        }));

      /*
       * Prefer the most popular shared movie.
       */

      sharedMovies.sort(
        (a, b) =>
          (b.movie.popularity || 0) -
          (a.movie.popularity || 0)
      );

      /*
       * DIRECT CONNECTION FOUND
       */

      if (sharedMovies.length > 0) {
        const shared = sharedMovies[0].movie;

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

              movie: movieData(shared)
            }
          ]
        });
      }

      /*
       * =====================================================
       * NO DIRECT CONNECTION
       *
       * Do a LIMITED second-level search.
       *
       * We use Actor A's most popular movies and look at their
       * casts in parallel rather than sequentially.
       * =====================================================
       */

      const popularMovies = [...creditsA]
        .sort(
          (a, b) =>
            (b.popularity || 0) -
            (a.popularity || 0)
        )
        .slice(0, 15);

      const castResults = await Promise.all(
        popularMovies.map(async movie => {
          try {
            const data = await tmdb(
              `/movie/${movie.id}/credits?language=en-US`
            );

            return {
              movie,
              cast: data.cast || []
            };
          } catch {
            return {
              movie,
              cast: []
            };
          }
        })
      );

      /*
       * See if the target actor appears in any of these movies.
       */

      for (const result of castResults) {
        const target = result.cast.find(
          person =>
            person.id === actorB.id &&
            realActingCredit(person)
        );

        if (target) {
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

                movie: movieData(result.movie)
              }
            ]
          });
        }
      }

      /*
       * We haven't found a connection yet.
       *
       * Return a clean result rather than leaving the user
       * staring at "Searching the Movie Universe."
       */

      return res.status(404).json({
        error:
          `No connection found yet between ${actorA.name} and ${actorB.name}.`
      });

    } catch (error) {
      console.error("Six Degrees error:", error);

      return res.status(500).json({
        error: "Six Degrees search failed."
      });
    }
  }

  /*
   * =========================================================
   * NORMAL REELWISE SEARCH
   * =========================================================
   */

  try {
    if (type === "movie") {
      const data = await tmdb(
        `/search/movie?query=${encodeURIComponent(
          q || ""
        )}&language=en-US`
      );

      return res.status(200).json(data);
    }

    if (type === "person") {
      const data = await tmdb(
        `/search/person?query=${encodeURIComponent(
          q || ""
        )}&language=en-US`
      );

      return res.status(200).json(data);
    }

    if (type === "movie-details") {
      const data = await tmdb(
        `/movie/${id}?language=en-US&append_to_response=credits`
      );

      return res.status(200).json(data);
    }

    if (type === "person-details") {
      const data = await tmdb(
        `/person/${id}?language=en-US&append_to_response=combined_credits`
      );

      return res.status(200).json(data);
    }

    const data = await tmdb(
      `/search/multi?query=${encodeURIComponent(
        q || ""
      )}&language=en-US`
    );

    return res.status(200).json(data);

  } catch (error) {
    console.error("Reelwise search error:", error);

    return res.status(500).json({
      error: "Search failed."
    });
  }
}
