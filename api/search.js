export default async function handler(req, res) {
  const token = process.env.TMDB_READ_ACCESS_TOKEN;
  const { q, type, id, from, to } = req.query;
  if (!token) {
    return res.status(500).json({
      error: "TMDB token is not configured."
    });
  }
  async function tmdb(endpoint) {
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
      const text = await response.text();
      throw new Error(`TMDB ${response.status}: ${text}`);
    }
    return response.json();
  }
  try {
    /*
     * ============================================================
     * SIX DEGREES
     * ============================================================
     */
    if (type === "degrees") {
      if (!from || !to) {
        return res.status(400).json({
          error: "Enter two actors."
        });
      }
      // ----------------------------------------------------------
      // Find an actor by name
      // ----------------------------------------------------------
      async function findActor(name) {
        const data = await tmdb(
          `/search/person?query=${encodeURIComponent(
            name
          )}&include_adult=false&language=en-US&page=1`
        );
        const people = data.results || [];
        const exact = people.find(
          person =>
            person.name &&
            person.name.toLowerCase() ===
              name.trim().toLowerCase()
        );
        const actor =
          exact ||
          people.find(
            person =>
              person.known_for_department === "Acting"
          ) ||
          people[0];
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
      const start = await findActor(from);
      const target = await findActor(to);
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
      // ----------------------------------------------------------
      // Get real movie acting credits
      // ----------------------------------------------------------
      const peopleMovies = new Map();
      const movieCredits = new Map();
      function validActingCredit(movie) {
        if (!movie || !movie.id || !movie.title) {
          return false;
        }
        const character = String(
          movie.character || ""
        )
          .trim()
          .toLowerCase();
        // Must have an actual character.
        if (!character) {
          return false;
        }
        // Never count Self appearances.
        if (
          character === "self" ||
          character === "himself" ||
          character === "herself" ||
          character === "themselves"
        ) {
          return false;
        }
        // Never count archive footage.
        if (
          character.includes("archive footage") ||
          character.includes("archival footage")
        ) {
          return false;
        }
        // Never count documentaries.
        if (
          Array.isArray(movie.genre_ids) &&
          movie.genre_ids.includes(99)
        ) {
          return false;
        }
        return true;
      }
      async function getMovies(personId) {
        if (peopleMovies.has(personId)) {
          return peopleMovies.get(personId);
        }
        const data = await tmdb(
          `/person/${personId}/movie_credits?language=en-US`
        );
        const movies = (data.cast || [])
          .filter(validActingCredit)
          .map(movie => ({
            id: movie.id,
            title: movie.title,
            year: (movie.release_date || "").slice(0, 4),
            character: movie.character || ""
          }));
        peopleMovies.set(personId, movies);
        return movies;
      }
      // ----------------------------------------------------------
      // DIRECT CONNECTION
      //
      // This is checked FIRST.
      // If two actors were in the same movie, we're done.
      // ----------------------------------------------------------
      const startMovies = await getMovies(start.id);
      const targetMovies = await getMovies(target.id);
      const targetMovieIds = new Set(
        targetMovies.map(movie =>
          String(movie.id)
        )
      );
      const direct = startMovies.find(movie =>
        targetMovieIds.has(String(movie.id))
      );
      if (direct) {
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
                id: direct.id,
                title: direct.title,
                year: direct.year
              }
            }
          ]
        });
      }
      // ----------------------------------------------------------
      // SECOND DIRECT CHECK BY TITLE
      //
      // This protects us if TMDB happens to return different
      // movie IDs for the same film.
      // ----------------------------------------------------------
      const normalize = value =>
        String(value || "")
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "");
      const targetTitles = new Map();
      for (const movie of targetMovies) {
        const key = normalize(movie.title);
        if (key) {
          targetTitles.set(key, movie);
        }
      }
      const titleMatch = startMovies.find(movie =>
        targetTitles.has(normalize(movie.title))
      );
      if (titleMatch) {
        const targetMovie =
          targetTitles.get(
            normalize(titleMatch.title)
          );
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
                id: titleMatch.id,
                title: titleMatch.title,
                year:
                  titleMatch.year ||
                  targetMovie.year ||
                  ""
              }
            }
          ]
        });
      }
      // ----------------------------------------------------------
      // CO-STAR SEARCH
      //
      // Find actors who worked with each actor.
      // Search outward until six movie connections.
      // ----------------------------------------------------------
      async function getCast(movieId) {
        if (movieCredits.has(movieId)) {
          return movieCredits.get(movieId);
        }
        const data = await tmdb(
          `/movie/${movieId}/credits?language=en-US`
        );
        const cast = (data.cast || [])
          .filter(person => {
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
          .slice(0, 50);
        movieCredits.set(movieId, cast);
        return cast;
      }
      // ----------------------------------------------------------
      // BFS
      // ----------------------------------------------------------
      const queue = [
        {
          actor: start,
          path: [
            {
              person: start,
              movie: null
            }
          ]
        }
      ];
      const visited = new Set([start.id]);
      let answer = null;
      while (queue.length > 0 && !answer) {
        const current = queue.shift();
        const currentDistance =
          current.path.length - 1;
        if (currentDistance >= 6) {
          continue;
        }
        const movies = await getMovies(
          current.actor.id
        );
        for (const movie of movies.slice(0, 75)) {
          const cast = await getCast(movie.id);
          for (const person of cast) {
            if (person.id === current.actor.id) {
              continue;
            }
            if (visited.has(person.id)) {
              continue;
            }
            visited.add(person.id);
            const nextPerson = {
              id: person.id,
              name: person.name
            };
            const nextPath = [
              ...current.path,
              {
                person: nextPerson,
                movie: {
                  id: movie.id,
                  title: movie.title,
                  year: movie.year
                }
              }
            ];
            if (person.id === target.id) {
              answer = nextPath;
              break;
            }
            if (nextPath.length - 1 < 6) {
              queue.push({
                actor: nextPerson,
                path: nextPath
              });
            }
          }
          if (answer) {
            break;
          }
        }
      }
      // ----------------------------------------------------------
      // RESULT
      // ----------------------------------------------------------
      if (!answer) {
        return res.status(404).json({
          error:
            "No movie connection found within six degrees.",
          path: []
        });
      }
      return res.status(200).json({
        from: start,
        to: target,
        distance: answer.length - 1,
        path: answer
      });
    }
    /*
     * ============================================================
     * NORMAL REELWISE SEARCH
     * ============================================================
     */
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
        error && error.message
          ? error.message
          : "Reelwise encountered an error."
    });
  }
}
