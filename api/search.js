const TOKEN = process.env.TMDB_READ_ACCESS_TOKEN;

async function tmdb(endpoint) {
  if (!TOKEN) {
    throw new Error("TMDB_READ_ACCESS_TOKEN is not configured.");
  }

  const response = await fetch(`https://api.themoviedb.org/3${endpoint}`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      accept: "application/json",
    },
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.status_message || "TMDB request failed.");
  }

  return data;
}

function cleanName(name) {
  return String(name || "").trim();
}

function yearFromDate(date) {
  return date ? String(date).slice(0, 4) : "";
}

async function findActor(name) {
  const q = cleanName(name);

  if (!q) {
    throw new Error("Actor name is required.");
  }

  const data = await tmdb(
    `/search/person?query=${encodeURIComponent(q)}&language=en-US&include_adult=false`
  );

  const people = Array.isArray(data.results) ? data.results : [];

  const actor = people.find((person) =>
    Array.isArray(person.known_for_department)
      ? person.known_for_department.includes("Acting")
      : person.known_for_department === "Acting"
  ) || people[0];

  if (!actor) {
    throw new Error(`Could not find actor "${q}".`);
  }

  return actor;
}

async function getMovieCredits(personId) {
  const data = await tmdb(
    `/person/${personId}/movie_credits?language=en-US`
  );

  return Array.isArray(data.cast) ? data.cast : [];
}

async function getMovieCast(movieId) {
  const data = await tmdb(
    `/movie/${movieId}/credits?language=en-US`
  );

  return Array.isArray(data.cast) ? data.cast : [];
}

function movieInfo(movie) {
  return {
    id: movie.id,
    title: movie.title || movie.original_title || "Untitled",
    year: yearFromDate(movie.release_date),
  };
}

function sortMovies(movies) {
  return [...movies].sort((a, b) => {
    const popularityA = Number(a.popularity || 0);
    const popularityB = Number(b.popularity || 0);

    if (popularityA !== popularityB) {
      return popularityB - popularityA;
    }

    const votesA = Number(a.vote_count || 0);
    const votesB = Number(b.vote_count || 0);

    return votesB - votesA;
  });
}

function makePathActor(person) {
  return {
    person: {
      id: person.id,
      name: person.name,
    },
  };
}

function makePathStep(person, movie) {
  return {
    person: {
      id: person.id,
      name: person.name,
    },
    movie: movieInfo(movie),
  };
}

async function findSixDegrees(fromName, toName) {
  const from = await findActor(fromName);
  const to = await findActor(toName);

  if (from.id === to.id) {
    return {
      from: {
        id: from.id,
        name: from.name,
      },
      to: {
        id: to.id,
        name: to.name,
      },
      distance: 0,
      path: [makePathActor(from)],
    };
  }

  const fromCredits = await getMovieCredits(from.id);

  const movieCache = new Map();
  const personCreditCache = new Map();

  personCreditCache.set(from.id, fromCredits);

  async function getCachedCredits(personId) {
    if (!personCreditCache.has(personId)) {
      personCreditCache.set(personId, await getMovieCredits(personId));
    }

    return personCreditCache.get(personId);
  }

  async function getCachedCast(movieId) {
    if (!movieCache.has(movieId)) {
      movieCache.set(movieId, await getMovieCast(movieId));
    }

    return movieCache.get(movieId);
  }

  // First check for a direct connection.
  const directMovies = fromCredits.filter((movie) =>
    Number.isFinite(Number(movie.id))
  );

  for (const movie of sortMovies(directMovies)) {
    const cast = await getCachedCast(movie.id);

    if (cast.some((person) => person.id === to.id)) {
      return {
        from: {
          id: from.id,
          name: from.name,
        },
        to: {
          id: to.id,
          name: to.name,
        },
        distance: 1,
        path: [
          makePathActor(from),
          makePathStep(to, movie),
        ],
      };
    }
  }

  /*
    Breadth-first search.

    Each level represents one movie connection.

    Example:

    Tom Cruise
       ↓ Top Gun
    Val Kilmer
       ↓ Heat
    Robert De Niro

    Distance = 2
  */

  const queue = [];

  queue.push({
    actor: from,
    distance: 0,
    path: [makePathActor(from)],
  });

  const visited = new Set([from.id]);

  const MAX_DEGREES = 6;

  while (queue.length > 0) {
    const current = queue.shift();

    if (current.distance >= MAX_DEGREES) {
      continue;
    }

    const credits = await getCachedCredits(current.actor.id);

    /*
      We don't impose a year restriction.
      We simply prioritize more prominent movies so the search
      has a reasonable chance of completing within Vercel's limits.
    */
    const movies = sortMovies(credits)
      .filter((movie) => movie && movie.id)
      .slice(0, 50);

    for (const movie of movies) {
      const cast = await getCachedCast(movie.id);

      /*
        Put the target first so we can immediately finish
        if the target appears in this movie.
      */
      const orderedCast = [...cast].sort((a, b) => {
        if (a.id === to.id) return -1;
        if (b.id === to.id) return 1;

        const popularityA = Number(a.popularity || 0);
        const popularityB = Number(b.popularity || 0);

        return popularityB - popularityA;
      });

      for (const person of orderedCast) {
        if (!person || !person.id || !person.name) {
          continue;
        }

        const nextDistance = current.distance + 1;

        if (person.id === to.id) {
          return {
            from: {
              id: from.id,
              name: from.name,
            },
            to: {
              id: to.id,
              name: to.name,
            },
            distance: nextDistance,
            path: [
              ...current.path,
              makePathStep(to, movie),
            ],
          };
        }

        if (nextDistance >= MAX_DEGREES) {
          continue;
        }

        if (visited.has(person.id)) {
          continue;
        }

        visited.add(person.id);

        queue.push({
          actor: {
            id: person.id,
            name: person.name,
          },
          distance: nextDistance,
          path: [
            ...current.path,
            makePathStep(person, movie),
          ],
        });
      }
    }
  }

  throw new Error(
    `No movie connection found between ${from.name} and ${to.name} within six films.`
  );
}

function sendError(res, status, message) {
  return res.status(status).json({
    error: message,
  });
}

export default async function handler(req, res) {
  try {
    const query = req.query || {};
    const type = query.type;
    const q = cleanName(query.q);
    const id = query.id;

    /*
      SIX DEGREES
    */
    if (type === "degrees") {
      const from = cleanName(query.from);
      const to = cleanName(query.to);

      if (!from || !to) {
        return sendError(
          res,
          400,
          "Please provide two actor names."
        );
      }

      const result = await findSixDegrees(from, to);

      return res.status(200).json(result);
    }

    /*
      MOVIE DETAILS
    */
    if (type === "movie-details" || (type === "movie" && id)) {
      return res.status(200).json(
        await tmdb(`/movie/${encodeURIComponent(id)}?language=en-US`)
      );
    }

    /*
      PERSON DETAILS
    */
    if (type === "person-details" || (type === "person" && id)) {
      const person = await tmdb(
        `/person/${encodeURIComponent(id)}?language=en-US`
      );

      const credits = await tmdb(
        `/person/${encodeURIComponent(id)}/combined_credits?language=en-US`
      );

      return res.status(200).json({
        ...person,
        credits,
      });
    }

    /*
      MOVIE SEARCH
    */
    if (type === "movie") {
      const data = await tmdb(
        `/search/movie?query=${encodeURIComponent(
          q || ""
        )}&language=en-US&include_adult=false`
      );

      return res.status(200).json(data);
    }

    /*
      PERSON SEARCH
    */
    if (type === "person") {
      return res.status(200).json(
        await tmdb(
          `/search/person?query=${encodeURIComponent(
            q || ""
          )}&language=en-US&include_adult=false`
        )
      );
    }

    /*
      DEFAULT SEARCH
    */
    const searchTerm = q || "";

    const [movies, people] = await Promise.all([
      tmdb(
        `/search/movie?query=${encodeURIComponent(
          searchTerm
        )}&language=en-US&include_adult=false`
      ),
      tmdb(
        `/search/person?query=${encodeURIComponent(
          searchTerm
        )}&language=en-US&include_adult=false`
      ),
    ]);

    return res.status(200).json({
      movies: movies.results || [],
      people: people.results || [],
    });
  } catch (error) {
    console.error("Reelwise API error:", error);

    return sendError(
      res,
      500,
      error?.message || "Something went wrong."
    );
  }
}
