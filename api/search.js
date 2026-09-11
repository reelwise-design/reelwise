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

  function normalize(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  }

  function isRealActingCredit(credit) {
    if (!credit) return false;

    const character = String(credit.character || "").toLowerCase();

    if (!character) return false;

    const bad = [
      "self",
      "himself",
      "herself",
      "themselves",
      "archive footage",
      "archive",
      "interviewee",
      "interviewer"
    ];

    if (bad.some(word => character.includes(word))) {
      return false;
    }

    if (
      Array.isArray(credit.genre_ids) &&
      credit.genre_ids.includes(99)
    ) {
      return false;
    }

    return true;
  }

  async function findActor(name) {
    const data = await tmdb(
      `/search/person?query=${encodeURIComponent(name)}&language=en-US`
    );

    const results = Array.isArray(data.results)
      ? data.results
      : [];

    if (!results.length) return null;

    const exact = results.find(
      person =>
        person.name &&
        person.name.toLowerCase() === name.toLowerCase() &&
        person.known_for_department === "Acting"
    );

    if (exact) return exact;

    const acting = results.find(
      person => person.known_for_department === "Acting"
    );

    return acting || results[0];
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

  async function getActorMovies(actorId) {
    const data = await tmdb(
      `/person/${actorId}/movie_credits?language=en-US`
    );

    return (data.cast || [])
      .filter(isRealActingCredit)
      .filter(movie => movie.id && movie.title)
      .sort(
        (a, b) =>
          (b.popularity || 0) -
          (a.popularity || 0)
      );
  }

  async function getMovieCast(movieId) {
    const data = await tmdb(
      `/movie/${movieId}/credits?language=en-US`
    );

    return (data.cast || [])
      .filter(isRealActingCredit)
      .filter(person => person.id && person.name);
  }

  function findSharedMovie(moviesA, moviesB) {
    const byId = new Map();

    for (const movie of moviesB) {
      byId.set(movie.id, movie);
    }

    for (const movie of moviesA) {
      if (byId.has(movie.id)) {
        return movie;
      }
    }

    const byTitle = new Map();

    for (const movie of moviesB) {
      byTitle.set(normalize(movie.title), movie);
    }

    for (const movie of moviesA) {
      if (byTitle.has(normalize(movie.title))) {
        return movie;
      }
    }

    return null;
  }

  async function directConnection(actorA, actorB) {
    const [moviesA, moviesB] = await Promise.all([
      getActorMovies(actorA.id),
      getActorMovies(actorB.id)
    ]);

    const shared = findSharedMovie(moviesA, moviesB);

    if (!shared) {
      return null;
    }

    return {
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
          movie: movieInfo(shared)
        }
      ]
    };
  }

  async function findConnection(actorA, actorB) {
    /*
      First: direct connection.

      This is the most important test and should be very fast.
      Example:
      Tom Cruise → Michelle Monaghan
      = Mission: Impossible – Fallout
    */

    const direct = await directConnection(actorA, actorB);

    if (direct) {
      return direct;
    }

    /*
      Controlled Six Degrees search.

      We deliberately keep these numbers small so the site
      doesn't get stuck making hundreds of TMDB requests.
    */

    const MAX_DEGREES = 6;
    const MAX_MOVIES_PER_ACTOR = 10;
    const MAX_CAST_PER_MOVIE = 35;
    const MAX_ACTORS_PER_LEVEL = 25;

    const actorCache = new Map();
    const movieCache = new Map();

    actorCache.set(actorA.id, {
      person: actorA,
      movies: await getActorMovies(actorA.id)
    });

    async function moviesForActor(actorId) {
      if (!actorCache.has(actorId)) {
        const movies = await getActorMovies(actorId);

        actorCache.set(actorId, {
          person: null,
          movies
        });
      }

      return actorCache.get(actorId).movies;
    }

    async function castForMovie(movieId) {
      if (movieCache.has(movieId)) {
        return movieCache.get(movieId);
      }

      const cast = await getMovieCast(movieId);

      const limited = cast
        .sort(
          (a, b) =>
            (b.popularity || 0) -
            (a.popularity || 0)
        )
        .slice(0, MAX_CAST_PER_MOVIE);

      movieCache.set(movieId, limited);

      return limited;
    }

    /*
      Each queue item represents an actor we've reached,
      plus the path used to reach that actor.
    */

    let frontier = [
      {
        person: actorA,
        path: [
          {
            person: {
              id: actorA.id,
              name: actorA.name
            }
          }
        ]
      }
    ];

    const visited = new Set([actorA.id]);

    for (let degree = 1; degree <= MAX_DEGREES; degree++) {
      const next = [];

      /*
        Look at movies for the current actors.
      */

      for (const node of frontier) {
        const movies = await moviesForActor(node.person.id);

        const selectedMovies = movies
          .slice(0, MAX_MOVIES_PER_ACTOR);

        /*
          Check the most popular movies first.
        */

        for (const movie of selectedMovies) {
          const cast = await castForMovie(movie.id);

          /*
            Is our target actor in this movie?
          */

          const target = cast.find(
            person => person.id === actorB.id
          );

          if (target) {
            return {
              distance: degree,
              path: [
                ...node.path,
                {
                  person: {
                    id: actorB.id,
                    name: actorB.name
                  },
                  movie: movieInfo(movie)
                }
              ]
            };
          }

          /*
            Add promising actors to the next level.
          */

          for (const person of cast) {
            if (!person.id) continue;
            if (person.id === actorA.id) continue;
            if (visited.has(person.id)) continue;

            visited.add(person.id);

            next.push({
              person,
              path: [
                ...node.path,
                {
                  person: {
                    id: person.id,
                    name: person.name
                  },
                  movie: movieInfo(movie)
                }
              ]
            });

            if (next.length >= MAX_ACTORS_PER_LEVEL) {
              break;
            }
          }

          if (next.length >= MAX_ACTORS_PER_LEVEL) {
            break;
          }
        }

        if (next.length >= MAX_ACTORS_PER_LEVEL) {
          break;
        }
      }

      /*
        Prefer the most popular actors for the next level.
      */

      next.sort(
        (a, b) =>
          (b.person.popularity || 0) -
          (a.person.popularity || 0)
      );

      frontier = next.slice(0, MAX_ACTORS_PER_LEVEL);

      if (!frontier.length) {
        break;
      }
    }

    return null;
  }

  /*
    SIX DEGREES
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

      const result = await findConnection(
        actorA,
        actorB
      );

      if (!result) {
        return res.status(404).json({
          error:
            `No connection found within six degrees between ${actorA.name} and ${actorB.name}.`
        });
      }

      return res.status(200).json({
        from: {
          id: actorA.id,
          name: actorA.name
        },

        to: {
          id: actorB.id,
          name: actorB.name
        },

        distance: result.distance,
        path: result.path
      });

    } catch (error) {
      console.error("Six Degrees error:", error);

      return res.status(500).json({
        error: "Six Degrees search failed."
      });
    }
  }

  /*
    NORMAL REELWISE SEARCH
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
