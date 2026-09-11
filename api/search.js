export default async function handler(req, res) {
  const token = process.env.TMDB_READ_ACCESS_TOKEN;

  if (!token) {
    return res.status(500).json({
      error: "TMDB API token is not configured."
    });
  }

  const {
    q,
    type,
    id,
    from,
    to
  } = req.query;

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

  function isRealActingCredit(credit) {
    if (!credit) return false;

    const character = String(credit.character || "").toLowerCase();

    if (!character) return false;

    const excluded = [
      "self",
      "himself",
      "herself",
      "themselves",
      "archive footage",
      "archive",
      "uncredited archive footage"
    ];

    return !excluded.some(word => character.includes(word));
  }

  async function findActor(name) {
    const data = await tmdb(
      `/search/person?query=${encodeURIComponent(name)}&language=en-US`
    );

    if (!data.results || !data.results.length) {
      return null;
    }

    const exact = data.results.find(
      person => person.name.toLowerCase() === name.toLowerCase()
    );

    return exact || data.results[0];
  }

  async function getMovieCredits(personId) {
    const data = await tmdb(
      `/person/${personId}/movie_credits?language=en-US`
    );

    return (data.cast || []).filter(isRealActingCredit);
  }

  async function getMovieCast(movieId) {
    const data = await tmdb(
      `/movie/${movieId}/credits?language=en-US`
    );

    return data.cast || [];
  }

  function movieInfo(movie) {
    return {
      id: movie.id,
      title: movie.title,
      year: movie.release_date
        ? movie.release_date.substring(0, 4)
        : ""
    };
  }

  /*
   * SIX DEGREES
   *
   * First we find the two actors.
   * Then we use the first actor's actual movie credits.
   * For each movie, we inspect the movie's actual cast.
   *
   * This prevents documentaries, "Self" appearances,
   * archive footage and other non-acting appearances
   * from creating fake connections.
   */

  if (type === "degrees") {
    try {
      if (!from || !to) {
        return res.status(400).json({
          error: "Two actors are required."
        });
      }

      const actorA = await findActor(from);
      const actorB = await findActor(to);

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

      const creditsA = await getMovieCredits(actorA.id);

      /*
       * Put the most popular movies first.
       * This makes common connections much faster.
       */
      creditsA.sort(
        (a, b) => (b.popularity || 0) - (a.popularity || 0)
      );

      /*
       * Look through Actor A's movies.
       *
       * We limit the initial scan so the request doesn't
       * overwhelm Vercel/TMDB.
       */
      const moviesToCheck = creditsA.slice(0, 100);

      for (const movie of moviesToCheck) {
        try {
          const cast = await getMovieCast(movie.id);

          const target = cast.find(
            person =>
              person.id === actorB.id &&
              isRealActingCredit(person)
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
                  movie: movieInfo(movie)
                }
              ]
            });
          }
        } catch (movieError) {
          /*
           * If one movie fails, keep checking the others.
           */
          continue;
        }
      }

      /*
       * If there is no direct connection, build a limited
       * actor/movie graph for up to six degrees.
       *
       * We start with Actor A and expand outward.
       */

      const queue = [
        {
          person: actorA,
          path: [
            {
              person: {
                id: actorA.id,
                name: actorA.name
              }
            }
          ],
          distance: 0
        }
      ];

      const visitedActors = new Set([actorA.id]);
      const movieCache = new Map();

      while (queue.length) {
        const current = queue.shift();

        if (current.distance >= 6) {
          continue;
        }

        let credits;

        try {
          credits = await getMovieCredits(current.person.id);
        } catch (error) {
          continue;
        }

        credits.sort(
          (a, b) => (b.popularity || 0) - (a.popularity || 0)
        );

        /*
         * Check the most relevant movies for this actor.
         */
        const currentMovies = credits.slice(0, 40);

        for (const movie of currentMovies) {
          let cast;

          if (movieCache.has(movie.id)) {
            cast = movieCache.get(movie.id);
          } else {
            try {
              cast = await getMovieCast(movie.id);
              movieCache.set(movie.id, cast);
            } catch (error) {
              continue;
            }
          }

          for (const person of cast) {
            if (!isRealActingCredit(person)) {
              continue;
            }

            if (person.id === current.person.id) {
              continue;
            }

            /*
             * We found the target.
             */
            if (person.id === actorB.id) {
              const newPath = [
                ...current.path,
                {
                  person: {
                    id: person.id,
                    name: person.name
                  },
                  movie: movieInfo(movie)
                }
              ];

              return res.status(200).json({
                from: {
                  id: actorA.id,
                  name: actorA.name
                },
                to: {
                  id: actorB.id,
                  name: actorB.name
                },
                distance: current.distance + 1,
                path: newPath
              });
            }

            /*
             * Don't visit the same actor twice.
             * This prevents paths such as:
             *
             * Tom Cruise
             * → Michelle Monaghan
             * → Michelle Monaghan
             */
            if (!visitedActors.has(person.id)) {
              visitedActors.add(person.id);

              queue.push({
                person: {
                  id: person.id,
                  name: person.name
                },
                path: [
                  ...current.path,
                  {
                    person: {
                      id: person.id,
                      name: person.name
                    },
                    movie: movieInfo(movie)
                  }
                ],
                distance: current.distance + 1
              });
            }
          }
        }
      }

      return res.status(404).json({
        error: `No acting connection between ${actorA.name} and ${actorB.name} was found within six degrees.`
      });

    } catch (error) {
      console.error("Six Degrees error:", error);

      return res.status(500).json({
        error: "Six Degrees search failed. Please try again."
      });
    }
  }

  /*
   * NORMAL REELWISE SEARCH
   */

  try {
    if (type === "movie") {
      const data = await tmdb(
        `/search/movie?query=${encodeURIComponent(q || "")}&language=en-US`
      );

      return res.status(200).json(data);
    }

    if (type === "person") {
      const data = await tmdb(
        `/search/person?query=${encodeURIComponent(q || "")}&language=en-US`
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
      `/search/multi?query=${encodeURIComponent(q || "")}&language=en-US`
    );

    return res.status(200).json(data);

  } catch (error) {
    console.error("Reelwise search error:", error);

    return res.status(500).json({
      error: "Search failed. Please try again."
    });
  }
}
