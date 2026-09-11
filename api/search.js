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
      const text = await response.text();
      throw new Error(
        `TMDB request failed: ${response.status} ${text}`
      );
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
       * Find the actor in TMDB.
       */
      const findPerson = async (name) => {
        const data = await tmdb(
          `/search/person?query=${encodeURIComponent(
            name.trim()
          )}&include_adult=false&language=en-US&page=1`
        );

        const results = data.results || [];

        /*
         * Prefer an exact name match.
         */
        const exact = results.find(
          (person) =>
            person.name &&
            person.name.toLowerCase() ===
              name.trim().toLowerCase()
        );

        /*
         * Otherwise prefer someone whose department
         * is Acting.
         */
        const actor =
          exact ||
          results.find(
            (person) =>
              person.known_for_department === "Acting"
          );

        if (!actor) {
          throw new Error(
            `I couldn't find ${name}.`
          );
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
       * ============================================================
       * CREDIT FILTERING
       * ============================================================
       */

      const isRealActingCredit = (credit) => {
        if (!credit) {
          return false;
        }

        if (!credit.id) {
          return false;
        }

        if (!credit.title) {
          return false;
        }

        /*
         * Exclude documentaries.
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
         * Require an actual character.
         */
        if (!character) {
          return false;
        }

        /*
         * Exclude appearances as themselves.
         */
        if (
          character === "self" ||
          character === "himself" ||
          character === "herself" ||
          character === "themselves"
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
       * ============================================================
       * PERSON MOVIE CREDITS
       * ============================================================
       */

      const personMoviesCache = new Map();

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
              movie.title &&
              movie.id
          )
          .map((movie) => ({
            id: movie.id,
            title: movie.title,
            release_date:
              movie.release_date || "",
            character:
              movie.character || "",
            genre_ids:
              movie.genre_ids || []
          }));

        personMoviesCache.set(
          personId,
          movies
        );

        return movies;
      };

      /*
       * ============================================================
       * MOVIE CAST
       * ============================================================
       */

      const movieCastCache = new Map();

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
          .slice(0, 100);

        movieCastCache.set(
          movieId,
          cast
        );

        return cast;
      };

      /*
       * ============================================================
       * DIRECT CONNECTION
       * ============================================================
       *
       * This is the most important part.
       *
       * We compare the complete TMDB movie-credit lists for
       * both actors using the actual movie ID.
       *
       * Example:
       *
       * Tom Cruise
       * Michelle Monaghan
       *
       * Both have:
       * Mission: Impossible - Fallout
       *
       * Therefore:
       *
       * Tom Cruise
       *       ↓
       * Mission: Impossible - Fallout
       *       ↓
       * Michelle Monaghan
       *
       * Distance = 1
       */

      const startMovies =
        await getPersonMovies(start.id);

      const targetMovies =
        await getPersonMovies(target.id);

      /*
       * Use movie ID as the primary match.
       */
      const targetMovieIds =
        new Set(
          targetMovies.map(
            (movie) => String(movie.id)
          )
        );

      const directMovie =
        startMovies.find(
          (movie) =>
            targetMovieIds.has(
              String(movie.id)
            )
        );

      if (directMovie) {
        return res.status(200).json({
          from: start,
          to: target,
          distance: 1,
          path: [
            {
              person: {
                id: start.id,
                name: start.name
              },
              movie: null
            },
            {
              person: {
                id: target.id,
                name: target.name
              },
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
       * FALLBACK DIRECT MATCH BY TITLE
       * ============================================================
       *
       * Occasionally TMDB data can contain duplicate or slightly
       * different credit records for the same movie.
       *
       * So we also compare normalized movie titles.
       */

      const normalizeTitle = (title) =>
        String(title || "")
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "");

      const targetTitleMap = new Map();

      for (const movie of targetMovies) {
        const key =
          normalizeTitle(movie.title);

        if (key) {
          targetTitleMap.set(
            key,
            movie
          );
        }
      }

      const titleMatch =
        startMovies.find((movie) =>
          targetTitleMap.has(
            normalizeTitle(movie.title)
          )
        );

      if (titleMatch) {
        const matchedMovie =
          targetTitleMap.get(
            normalizeTitle(titleMatch.title)
          );

        return res.status(200).json({
          from: start,
          to: target,
          distance: 1,
          path: [
            {
              person: {
                id: start.id,
                name: start.name
              },
              movie: null
            },
            {
              person: {
                id: target.id,
                name: target.name
              },
              movie: {
                id:
                  matchedMovie.id ||
                  titleMatch.id,
                title:
                  titleMatch.title,
                year: (
                  titleMatch.release_date ||
                  matchedMovie.release_date ||
                  ""
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

      const visitedA =
        new Set([start.id]);

      const visitedB =
        new Set([target.id]);

      const parentA = new Map();
      const parentB = new Map();

      let depthA = 0;
      let depthB = 0;

      let meetingId = null;

      /*
       * Expand one side of the graph.
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
           * Keep the search practical.
           */
          const selectedMovies =
            movies.slice(0, 100);

          /*
           * Process movies in batches.
           */
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
                 * Never connect an actor to themselves.
                 */
                if (
                  person.id === actor.id
                ) {
                  continue;
                }

                /*
                 * Don't revisit an actor on the
                 * same side.
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
                    previous:
                      actor.id,
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
       * Search up to six degrees.
       */
      while (
        !meetingId &&
        depthA + depthB < 6 &&
        frontierA.length > 0 &&
        frontierB.length > 0
      ) {
        /*
         * Expand the smaller frontier.
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
       * ============================================================
       * NO CONNECTION
       * ============================================================
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
       * RECONSTRUCT LEFT SIDE
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
              "Connection reconstruction failed.",
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
       * ============================================================
       * RECONSTRUCT RIGHT SIDE
       * ============================================================
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
              "Connection reconstruction failed.",
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

      right.reverse();

      /*
       * Combine the two sides.
       *
       * The meeting actor appears on both sides,
       * so remove it from the second side.
       */
      const combined = [
        ...left,
        ...right.slice(1)
      ];

      /*
       * ============================================================
       * REMOVE ANY DUPLICATE ACTORS
       * ============================================================
       */

      const seen = new Set();

      const cleanPath = [];

      for (const node of combined) {
        if (
          seen.has(node.id)
        ) {
          continue;
        }

        seen.add(node.id);
        cleanPath.push(node);
      }

      /*
       * ============================================================
       * GET ACTOR NAMES
       * ============================================================
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
       * ============================================================
       * FINAL PATH
       * ============================================================
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
