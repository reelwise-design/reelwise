export default async function handler(req, res) {
  const token = process.env.TMDB_READ_ACCESS_TOKEN;
  const { q, type, id, from, to } = req.query;

  if (!token) {
    return res.status(500).json({ error: "TMDB token is not configured" });
  }

  const tmdb = async (path) => {
    const response = await fetch(`https://api.themoviedb.org/3${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error("TMDB request failed");
    }

    return response.json();
  };

  try {
    if (type === "degrees") {
      if (!from || !to) {
        return res.status(400).json({ error: "Both actors are required" });
      }

      const findPerson = async (name) => {
        const data = await tmdb(
          `/search/person?query=${encodeURIComponent(name)}&include_adult=false&language=en-US&page=1`
        );

        const person =
          (data.results || []).find(
            (p) => p.known_for_department === "Acting"
          ) || data.results?.[0];

        if (!person) {
          throw new Error(`I couldn't find ${name}.`);
        }

        return { id: person.id, name: person.name };
      };

      const [start, target] = await Promise.all([
        findPerson(from),
        findPerson(to)
      ]);

      if (start.id === target.id) {
        return res.status(200).json({
          path: [{ id: start.id, name: start.name }]
        });
      }

      const personCache = new Map();
      const castCache = new Map();

      const getPersonCredits = async (personId) => {
        if (personCache.has(personId)) {
          return personCache.get(personId);
        }

        const data = await tmdb(
          `/person/${personId}/movie_credits?language=en-US`
        );

        const credits = (data.cast || [])
          .filter((movie) => movie.id && movie.title)
          .sort(
            (a, b) => (b.popularity || 0) - (a.popularity || 0)
          );

        personCache.set(personId, credits);
        return credits;
      };

      const getMovieCast = async (movieId) => {
        if (castCache.has(movieId)) {
          return castCache.get(movieId);
        }

        const data = await tmdb(
          `/movie/${movieId}/credits?language=en-US`
        );

        const cast = (data.cast || [])
          .filter((person) => person.id && person.name)
          .slice(0, 40);

        castCache.set(movieId, cast);
        return cast;
      };

      const buildFrontier = async (
        frontier,
        visited,
        parents,
        maxMovies = 40
      ) => {
        const next = [];

        for (const node of frontier) {
          const credits = await getPersonCredits(node.id);
          const movies = credits.slice(0, maxMovies);

          for (const movie of movies) {
            const cast = await getMovieCast(movie.id);

            for (const person of cast) {
              if (person.id === node.id || visited.has(person.id)) {
                continue;
              }

              visited.add(person.id);

              parents.set(person.id, {
                previous: node.id,
                movie: {
                  id: movie.id,
                  title: movie.title,
                  year: (movie.release_date || "").slice(0, 4)
                }
              });

              next.push({
                id: person.id,
                name: person.name
              });
            }
          }
        }

        return next;
      };

      let frontierA = [start];
      let frontierB = [target];

      const visitedA = new Set([start.id]);
      const visitedB = new Set([target.id]);

      const parentsA = new Map();
      const parentsB = new Map();

      let meetingId = null;

      for (let depth = 0; depth < 6 && !meetingId; depth++) {
        if (frontierA.length <= frontierB.length) {
          frontierA = await buildFrontier(
            frontierA,
            visitedA,
            parentsA
          );

          for (const node of frontierA) {
            if (visitedB.has(node.id)) {
              meetingId = node.id;
              break;
            }
          }
        } else {
          frontierB = await buildFrontier(
            frontierB,
            visitedB,
            parentsB
          );

          for (const node of frontierB) {
            if (visitedA.has(node.id)) {
              meetingId = node.id;
              break;
            }
          }
        }
      }

      if (!meetingId) {
        return res.status(404).json({
          error: "No connection found within six films",
          path: []
        });
      }

      const left = [];
      let cursor = meetingId;

      while (cursor !== start.id) {
        const edge = parentsA.get(cursor);
        if (!edge) break;

        left.push({
          id: cursor,
          movie: edge.movie
        });

        cursor = edge.previous;
      }

      left.push({ id: start.id });
      left.reverse();

      const right = [];
      cursor = meetingId;

      while (cursor !== target.id) {
        const edge = parentsB.get(cursor);
        if (!edge) break;

        right.push({
          id: cursor,
          movie: edge.movie
        });

        cursor = edge.previous;
      }

      right.push({ id: target.id });

      const ids = [...left, ...right.slice(1)];
      const uniqueIds = [...new Set(ids.map((node) => node.id))];

      const names = new Map([
        [start.id, start.name],
        [target.id, target.name]
      ]);

      await Promise.all(
        uniqueIds.map(async (personId) => {
          if (names.has(personId)) return;

          const data = await tmdb(
            `/person/${personId}?language=en-US`
          );

          names.set(personId, data.name);
        })
      );

      const path = ids.map((node, index) => ({
        id: node.id,
        name: names.get(node.id) || String(node.id),
        movie: index > 0 ? node.movie : null
      }));

      return res.status(200).json({ path });
    }

    let url;

    if (type === "movie" && id) {
      url = `/movie/${id}?language=en-US&append_to_response=credits`;
    } else if (type === "person" && id) {
      url = `/person/${id}?language=en-US&append_to_response=combined_credits`;
    } else if (q) {
      url = `/search/multi?query=${encodeURIComponent(
        q
      )}&include_adult=false&language=en-US&page=1`;
    } else {
      return res.status(400).json({
        error: "Missing search query or ID"
      });
    }

    const data = await tmdb(url);

    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({
      error: error.message || "Unable to connect to TMDB"
    });
  }
}
