export default async function handler(req, res) {
  const token = process.env.TMDB_READ_ACCESS_TOKEN;
  const { q, type, id, from, to } = req.query;

  if (!token) {
    return res.status(500).json({
      error: "TMDB token is not configured"
    });
  }

  const tmdb = async (path) => {
    const response = await fetch(
      `https://api.themoviedb.org/3${path}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          accept: "application/json"
        }
      }
    );

    if (!response.ok) {
      throw new Error("TMDB request failed");
    }

    return response.json();
  };

  try {
    /*
     * ============================================================
     * SIX DEGREES
     * ============================================================
     */

    if (type === "degrees") {
      if (!from || !to) {
        return res.status(400).json({
          error: "Both actors are required"
        });
      }

      /*
       * Find an actor by name.
       */
      const findPerson = async (name) => {
        const data = await tmdb(
          `/search/person?query=${encodeURIComponent(
            name.trim()
          )}&include_adult=false&language=en-US&page=1`
        );

        const results = data.results || [];

        const exact = results.find(
          (person) =>
            person.known_for_department === "Acting" &&
            person.name.toLowerCase() ===
              name.trim().toLowerCase()
        );

        const actor =
          exact ||
          results.find(
            (person) =>
              person.known_for_department === "Acting"
          );

        if (!actor) {
          throw new Error(`I couldn't find ${name}.`);
        }

        return {
          id: actor.id,
          name: actor.name
        };
      };

      const [start, target] = await Promise.all([
        findPerson(from),
        findPerson(to)
      ]);

      /*
       * Same actor.
       */
      if (start.id === target.id) {
        return res.status(200).json({
          from: start,
          to: target,
          distance: 0,
          path: [
            {
              person: start,
              movie: null
            }
          ]
        });
      }

      /*
       * Caches keep the number of TMDB requests manageable.
       */
      const personMoviesCache = new Map();
      const movieCastCache = new Map();

      /*
       * Determine whether a credit is a real acting role.
       */
      const isRealActingCredit = (credit) => {
        if (!credit || !credit.id || !credit.title) {
          return false;
        }

        /*
         * Documentary.
         */
        if (
          Array.isArray(credit.genre_ids) &&
          credit.genre_ids.includes(99)
        ) {
          return false;
        }

        const character = String(
          credit.character || ""
        )
          .trim()
          .toLowerCase();

        /*
         * No character usually means this is not useful
         * for the Six Degrees game.
         */
        if (!character) {
          return false;
        }

        /*
         * Exclude appearances as themselves.
         */
        if (
          /^(self|himself|herself|themselves)$/.test(
            character
          )
        ) {
          return false;
        }

        /*
         * Exclude archive footage.
         */
        if (
          character.includes("archive footage") ||
          character.includes("archival footage")
        ) {
          return false;
        }

        return true;
      };

      /*
       * Get movies for an actor.
       */
      const getPersonMovies = async (personId) => {
        if (personMoviesCache.has(personId)) {
          return personMoviesCache.get(personId);
        }

        const data = await tmdb(
          `/person/${personId}/movie_credits?language=en-US`
        );

        const movies = (data.cast || [])
          .filter(isRealActingCredit)
          .filter(
            (movie) =>
              movie.release_date &&
              movie.title
          )
          .sort(
            (a, b) =>
              new Date(b.release_date || 0) -
              new Date(a.release_date || 0)
          );

        personMoviesCache.set(
          personId,
          movies
        );

        return movies;
      };

      /*
       * Get the actual acting cast of a movie.
       */
      const getMovieCast = async (movieId) => {
        if (movieCastCache.has(movieId)) {
          return movieCastCache.get(movieId);
        }

        const data = await tmdb(
          `/movie/${movieId}/credits?language=en-US`
        );

        const cast = (data.cast || [])
          .filter((person) => {
            if (!person.id || !person.name) {
              return false;
            }

            const character = String(
              person.character || ""
            )
              .trim()
              .toLowerCase();

            if (!character) {
              return false;
            }

            if (
              /^(self|himself|herself|themselves)$/.test(
                character
              )
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
          .slice(0, 100);

        movieCastCache.set(
          movieId,
          cast
        );

        return cast;
      };

      /*
       * ============================================================
       * FIRST: CHECK FOR A DIRECT MOVIE CONNECTION
       * ============================================================
       *
       * This is important.
       *
       * If Tom Cruise and Michelle Monaghan were both
       * actual actors in the same movie, the answer is
       * immediately ONE connection.
       */

      const startMovies =
        await getPersonMovies(start.id);

      const targetMovies =
        await getPersonMovies(target.id);

      const targetMovieMap = new Map();

      for (const movie of targetMovies) {
        targetMovieMap.set(
          movie.id,
          movie
        );
      }

      const directMovie =
        startMovies.find((movie) =>
          targetMovieMap.has(movie.id)
        );

      if (directMovie) {
        return res.status(200).json({
          from: start,
          to: target,
          distance: 1,
          path: [
            {
              person: start,
              movie: null
            },
            {
              person: target,
              movie: {
                id: directMovie.id,
                title: directMovie.title,
                year: (
                  directMovie.release_date || ""
                ).slice(0, 4)
              }
            }
          ]
        });
      }

      /*
       * ============================================================
       * BIDIRECTIONAL BREADTH-FIRST SEARCH
       * ============================================================
       */

      let frontierA = [
        {
          id: start.id,
          name: start.name
        }
      ];

      let frontierB = [
        {
          id: target.id,
          name: target.name
        }
      ];

      const visitedA = new Set([
        start.id
      ]);

      const visitedB = new Set([
        target.id
      ]);

      const parentA = new Map();
      const parentB = new Map();

      let depthA = 0;
      let depthB = 0;
      let meetingId = null;

      /*
       * Expand one side of the search.
       */
      const expand = async (
        frontier,
        visited,
        parents
      ) => {
        const next = [];

        for (const actor of frontier) {
          const movies =
            await getPersonMovies(actor.id);

          /*
           * Limit each actor to the most useful
           * movie credits to keep the API practical.
           */
          const selectedMovies =
            movies.slice(0, 100);

          for (
            let i = 0;
            i < selectedMovies.length;
            i += 10
          ) {
            const batch =
              selectedMovies.slice(
                i,
                i + 10
              );

            const casts =
              await Promise.all(
                batch.map((movie) =>
                  getMovieCast(movie.id)
                )
              );

            for (
              let j = 0;
              j < casts.length;
              j++
            ) {
              const movie = batch[j];
              const cast = casts[j];

              for (const person of cast) {
                /*
                 * Never add the actor themselves.
                 */
                if (
                  person.id === actor.id
                ) {
                  continue;
                }

                /*
                 * Never add an actor twice
                 * on the same side of the search.
                 */
                if (
                  visited.has(person.id)
                ) {
                  continue;
                }

                visited.add(person.id);

                parents.set(
                  person.id,
                  {
                    previous: actor.id,
                    movie: {
                      id: movie.id,
                      title: movie.title,
                      year: (
                        movie.release_date ||
                        ""
                      ).slice(0, 4)
                    }
                  }
                );

                next.push({
                  id: person.id,
                  name: person.name
                });
              }
            }
          }
        }

        return next;
      };

      /*
       * Search up to six movie connections.
       */
      while (
        !meetingId &&
        depthA + depthB < 6 &&
        frontierA.length &&
        frontierB.length
      ) {
        /*
         * Always expand the smaller side.
         */
        if (
          frontierA.length <=
          frontierB.length
        ) {
          frontierA =
            await expand(
              frontierA,
              visitedA,
              parentA
            );

          depthA++;

          for (const actor of frontierA) {
            if (
              visitedB.has(actor.id)
            ) {
              meetingId =
                actor.id;
              break;
            }
          }
        } else {
          frontierB =
            await expand(
              frontierB,
              visitedB,
              parentB
            );

          depthB++;

          for (const actor of frontierB) {
            if (
              visitedA.has(actor.id)
            ) {
              meetingId =
                actor.id;
              break;
            }
          }
        }
      }

      /*
       * No connection.
       */
      if (!meetingId) {
        return res.status(404).json({
          error:
            "No connection found within six degrees.",
          path: []
        });
      }

      /*
       * ============================================================
       * RECONSTRUCT THE PATH
       * ============================================================
       */

      const left = [];

      let cursor = meetingId;

      while (
        cursor !== start.id
      ) {
        const edge =
          parentA.get(cursor);

        if (!edge) {
          return res.status(404).json({
            error:
              "The connection could not be reconstructed.",
            path: []
          });
        }

        left.push({
          id: cursor,
          movie: edge.movie
        });

        cursor =
          edge.previous;
      }

      left.push({
        id: start.id,
        movie: null
      });

      left.reverse();

      /*
       * Build the target side.
       */
      const right = [];

      cursor = meetingId;

      while (
        cursor !== target.id
      ) {
        const edge =
          parentB.get(cursor);

        if (!edge) {
          return res.status(404).json({
            error:
              "The connection could not be reconstructed.",
            path: []
          });
        }

        right.push({
          id: cursor,
          movie: edge.movie
        });

        cursor =
          edge.previous;
      }

      right.push({
        id: target.id,
        movie: null
      });

      /*
       * Reverse the target side.
       */
      right.reverse();

      /*
       * Combine both sides without duplicating
       * the meeting actor.
       */
      const combined = [
        ...left,
        ...right.slice(1)
      ];

      /*
       * Absolutely prevent duplicate actors
       * from appearing in the final answer.
       */
      const seenFinal = new Set();

      const cleanPath = [];

      for (const node of combined) {
        if (
          seenFinal.has(node.id)
        ) {
          continue;
        }

        seenFinal.add(node.id);
        cleanPath.push(node);
      }

      /*
       * Get names for intermediate actors.
       */
      const names = new Map([
        [start.id, start.name],
        [target.id, target.name]
      ]);

      for (const node of cleanPath) {
        if (
          names.has(node.id)
        ) {
          continue;
        }

        try {
          const data =
            await tmdb(
              `/person/${node.id}?language=en-US`
            );

          names.set(
            node.id,
            data.name ||
              String(node.id)
          );
        } catch {
          names.set(
            node.id,
            String(node.id)
          );
        }
      }

      /*
       * Build final Reelwise response.
       */
      const path =
        cleanPath.map(
          (node, index) => ({
            person: {
              id: node.id,
              name:
                names.get(node.id) ||
                String(node.id)
            },
            movie:
              index === 0
                ? null
                : node.movie || null
          })
        );

      return res.status(200).json({
        from: start,
        to: target,
        distance:
          Math.max(
            0,
            path.length - 1
          ),
        path
      });
    }

    /*
     * ============================================================
     * NORMAL REELWISE SEARCH
     * ============================================================
     */

    let url;

    if (
      type === "movie" &&
      id
    ) {
      url =
        `/movie/${id}` +
        `?language=en-US` +
        `&append_to_response=credits`;
    } else if (
      type === "person" &&
      id
    ) {
      url =
        `/person/${id}` +
        `?language=en-US` +
        `&append_to_response=combined_credits`;
    } else if (q) {
      url =
        `/search/multi?query=` +
        `${encodeURIComponent(q)}` +
        `&include_adult=false` +
        `&language=en-US&page=1`;
    } else {
      return res.status(400).json({
        error:
          "Missing search query or ID"
      });
    }

    const data =
      await tmdb(url);

    return res.status(200).json(data);

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error:
        error.message ||
        "Unable to connect to TMDB"
    });
  }
}
