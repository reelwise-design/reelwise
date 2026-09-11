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
    if (type === "degrees") {
      if (!from || !to) {
        return res.status(400).json({
          error: "Both actors are required"
        });
      }

      const findPerson = async (name) => {
        const data = await tmdb(
          `/search/person?query=${encodeURIComponent(
            name
          )}&include_adult=false&language=en-US&page=1`
        );

        const results = data.results || [];

        const exact = results.find(
          (p) =>
            p.known_for_department === "Acting" &&
            p.name.toLowerCase() ===
              name.trim().toLowerCase()
        );

        const actor =
          exact ||
          results.find(
            (p) =>
              p.known_for_department === "Acting"
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

      const formatMovie = (movie) => {
        if (!movie) return null;

        return {
          id: movie.id,
          title: movie.title,
          year: (movie.release_date || "").slice(0, 4)
        };
      };

      const formatResult = (path) => ({
        from: {
          id: start.id,
          name: start.name
        },
        to: {
          id: target.id,
          name: target.name
        },
        distance: Math.max(0, path.length - 1),
        path: path.map((node, index) => ({
          person: {
            id: node.id,
            name: node.name
          },
          movie:
            index === 0
              ? null
              : formatMovie(node.movie)
        }))
      });

      if (start.id === target.id) {
        return res.status(200).json(
          formatResult([
            {
              id: start.id,
              name: start.name,
              movie: null
            }
          ])
        );
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
          .filter((movie) => {
            if (
              !movie.id ||
              !movie.title ||
              !movie.release_date
            ) {
              return false;
            }

            // Exclude documentaries
            if (
              Array.isArray(movie.genre_ids) &&
              movie.genre_ids.includes(99)
            ) {
              return false;
            }

            // Exclude Self / archive appearances
            const character = (
              movie.character || ""
            )
              .trim()
              .toLowerCase();

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
          .filter((person) => {
            if (!person.id || !person.name) {
              return false;
            }

            const character = (
              person.character || ""
            )
              .trim()
              .toLowerCase();

            if (!character) return false;

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

        movieCastCache.set(movieId, cast);

        return cast;
      };

      // Check for a direct movie connection first.
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
        return res.status(200).json(
          formatResult([
            {
              id: start.id,
              name: start.name,
              movie: null
            },
            {
              id: target.id,
              name: target.name,
              movie: directMovie
            }
          ])
        );
      }

      // Bidirectional breadth-first search.
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

      const visitedA = new Set([start.id]);
      const visitedB = new Set([target.id]);

      const parentsA = new Map();
      const parentsB = new Map();

      let depthA = 0;
      let depthB = 0;
      let meetingId = null;

      const expand = async (
        frontier,
        visited,
        parents
      ) => {
        const next = [];

        for (const actor of frontier) {
          const movies = await getPersonMovies(
            actor.id
          );

          const selectedMovies = movies.slice(0, 100);

          for (
            let i = 0;
            i < selectedMovies.length;
            i += 8
          ) {
            const batch = selectedMovies.slice(
              i,
              i + 8
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
                    release_date:
                      movie.release_date || ""
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

      while (
        !meetingId &&
        depthA + depthB < 6 &&
        frontierA.length &&
        frontierB.length
      ) {
        if (
          frontierA.length <= frontierB.length
        ) {
          frontierA = await expand(
            frontierA,
            visitedA,
            parentsA
          );

          depthA++;

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

          depthB++;

          for (const actor of frontierB) {
            if (visitedA.has(actor.id)) {
              meetingId = actor.id;
              break;
            }
          }
        }
      }

      if (!meetingId) {
        return res.status(404).json({
          error:
            "No connection found within six degrees.",
          path: []
        });
      }

      // Build path from starting actor to meeting actor.
      const left = [];
      let cursor = meetingId;

      while (cursor !== start.id) {
        const edge = parentsA.get(cursor);

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

        cursor = edge.previous;
      }

      left.push({
        id: start.id,
        movie: null
      });

      left.reverse();

      // Build path from meeting actor to target actor.
      const right = [];
      cursor = meetingId;

      while (cursor !== target.id) {
        const edge = parentsB.get(cursor);

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

        cursor = edge.previous;
      }

      right.push({
        id: target.id,
        movie: null
      });

      right.reverse();

      const combined = [
        ...left,
        ...right.slice(1)
      ];

      const names = new Map([
        [start.id, start.name],
        [target.id, target.name]
      ]);

      for (const node of combined) {
        if (names.has(node.id)) continue;

        try {
          const data = await tmdb(
            `/person/${node.id}?language=en-US`
          );

          names.set(
            node.id,
            data.name || String(node.id)
          );
        } catch {
          names.set(
            node.id,
            String(node.id)
          );
        }
      }

      const path = combined.map((node) => ({
        id: node.id,
        name:
          names.get(node.id) ||
          String(node.id),
        movie: node.movie || null
      }));

      return res.status(200).json(
        formatResult(path)
      );
    }

    // NORMAL REELWISE SEARCH

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
