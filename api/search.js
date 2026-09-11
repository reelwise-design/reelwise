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
     * SIX DEGREES
     *
     * Dynamically connects any two actors through movies.
     * Maximum: 6 actor-to-actor connections.
     */

    if (type === "degrees") {
      if (!from || !to) {
        return res.status(400).json({
          error: "Both actors are required"
        });
      }

      // Find an actor by name
      const findPerson = async (name) => {
        const data = await tmdb(
          `/search/person?query=${encodeURIComponent(
            name
          )}&include_adult=false&language=en-US&page=1`
        );

        const person =
          (data.results || []).find(
            (p) => p.known_for_department === "Acting"
          ) || data.results?.[0];

        if (!person) {
          throw new Error(`I couldn't find ${name}.`);
        }

        return {
          id: person.id,
          name: person.name
        };
      };

      const [start, target] = await Promise.all([
        findPerson(from),
        findPerson(to)
      ]);

      if (start.id === target.id) {
        return res.status(200).json({
          path: [
            {
              id: start.id,
              name: start.name,
              movie: null
            }
          ]
        });
      }

      const personCreditsCache = new Map();
      const movieCastCache = new Map();

      const getPersonMovies = async (personId) => {
        if (personCreditsCache.has(personId)) {
          return personCreditsCache.get(personId);
        }

        const data = await tmdb(
          `/person/${personId}/movie_credits?language=en-US`
        );

        const movies = (data.cast || [])
          .filter(
            (movie) =>
              movie.id &&
              movie.title &&
              movie.release_date
          )
          .sort(
            (a, b) =>
              (b.popularity || 0) -
              (a.popularity || 0)
          );

        personCreditsCache.set(personId, movies);

        return movies;
      };

      const getMovieCast = async (movieId) => {
        if (movieCastCache.has(movieId)) {
          return movieCastCache.get(movieId);
        }

        const data = await tmdb(
          `/movie/${movieId}/credits?language=en-US`
        );

        const cast = (data.cast || [])
          .filter(
            (person) =>
              person.id &&
              person.name
          )
          .slice(0, 50);

        movieCastCache.set(movieId, cast);

        return cast;
      };

      /*
       * Expand a group of actors.
       *
       * We deliberately use small batches so Vercel
       * and TMDB aren't overwhelmed with requests.
       */
      const expand = async (
        frontier,
        visited,
        parents
      ) => {
        const next = [];

        for (const actor of frontier) {
          const movies = await getPersonMovies(actor.id);

          // Most useful/popular movies first.
          const selectedMovies = movies.slice(0, 30);

          // Fetch movie casts in parallel batches.
          const batchSize = 6;

          for (
            let i = 0;
            i < selectedMovies.length;
            i += batchSize
          ) {
            const batch = selectedMovies.slice(
              i,
              i + batchSize
            );

            const casts = await Promise.all(
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
                if (
                  person.id === actor.id ||
                  visited.has(person.id)
                ) {
                  continue;
                }

                visited.add(person.id);

                parents.set(person.id, {
                  previous: actor.id,
                  movie: {
                    id: movie.id,
                    title: movie.title,
                    year: (
                      movie.release_date || ""
                    ).slice(0, 4)
                  }
                });

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
       * Bidirectional breadth-first search.
       *
       * Searching from BOTH actors makes the search
       * dramatically smaller than searching outward
       * from only one actor.
       */

      let frontierA = [start];
      let frontierB = [target];

      const visitedA = new Set([start.id]);
      const visitedB = new Set([target.id]);

      const parentsA = new Map();
      const parentsB = new Map();

      let meetingId = null;

      /*
       * First check whether they appeared in the
       * same movie directly.
       */
      const startMovies = await getPersonMovies(
        start.id
      );

      const targetMovies = await getPersonMovies(
        target.id
      );

      const targetMovieIds = new Map(
        targetMovies.map((movie) => [
          movie.id,
          movie
        ])
      );

      const directMovie = startMovies.find((movie) =>
        targetMovieIds.has(movie.id)
      );

      if (directMovie) {
        return res.status(200).json({
          path: [
            {
              id: start.id,
              name: start.name,
              movie: null
            },
            {
              id: target.id,
              name: target.name,
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
       * Six actor-to-actor links maximum.
       */
      for (
        let depth = 0;
        depth < 6 && !meetingId;
        depth++
      ) {
        /*
         * Always expand the smaller side.
         */
        if (
          frontierA.length <= frontierB.length
        ) {
          frontierA = await expand(
            frontierA,
            visitedA,
            parentsA
          );

          for (const actor of frontierA) {
            if (visitedB.has(actor.id)) {
              meetingId = actor.id;
              break;
            }
          }
        } else {
          frontierB = await expand(
            frontierB,
            visitedB,
            parentsB
          );

          for (const actor of frontierB) {
            if (visitedA.has(actor.id)) {
              meetingId = actor.id;
              break;
            }
          }
        }

        /*
         * Stop if either side has become empty.
         */
        if (
          frontierA.length === 0 ||
          frontierB.length === 0
        ) {
          break;
        }
      }

      if (!meetingId) {
        return res.status(404).json({
          error:
            "No connection found within six degrees.",
          path: []
        });
      }

      /*
       * Reconstruct the path from the starting actor
       * to the meeting actor.
       */
      const left = [];

      let cursor = meetingId;

      while (cursor !== start.id) {
        const edge = parentsA.get(cursor);

        if (!edge) {
          break;
        }

        left.push({
          id: cursor,
          movie: edge.movie
        });

        cursor = edge.previous;
      }

      left.push({
        id: start.id,
        movie: null
      });

      left.reverse();

      /*
       * Reconstruct the path from the meeting actor
       * to the target actor.
       */
      const right = [];

      cursor = meetingId;

      while (cursor !== target.id) {
        const edge = parentsB.get(cursor);

        if (!edge) {
          break;
        }

        right.push({
          id: cursor,
          movie: edge.movie
        });

        cursor = edge.previous;
      }

      right.push({
        id: target.id,
        movie: null
      });

      /*
       * The movie associated with an actor on the
       * target-side search belongs to the connection
       * leading toward that actor, so reverse it.
       */
      right.reverse();

      /*
       * Combine the two halves without duplicating
       * the meeting actor.
       */
      const combined = [
        ...left,
        ...right.slice(1)
      ];

      /*
       * Fill in names for intermediary actors.
       */
      const names = new Map([
        [start.id, start.name],
        [target.id, target.name]
      ]);

      for (const node of combined) {
        if (names.has(node.id)) {
          continue;
        }

        const data = await tmdb(
          `/person/${node.id}?language=en-US`
        );

        names.set(
          node.id,
          data.name || String(node.id)
        );
      }

      const path = combined.map(
        (node, index) => ({
          id: node.id,
          name:
            names.get(node.id) ||
            String(node.id),
          movie:
            index === 0
              ? null
              : node.movie || null
        })
      );

      return res.status(200).json({
        path
      });
    }

    /*
     * NORMAL REELWISE SEARCH
     */

    let url;

    if (type === "movie" && id) {
      url =
        `/movie/${id}` +
        `?language=en-US` +
        `&append_to_response=credits`;
    } else if (type === "person" && id) {
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

    const data = await tmdb(url);

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
