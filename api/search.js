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

  if (!people.length) {
    throw new Error(`Could not find actor "${q}".`);
  }

  const normalized = q.toLowerCase();

  const exact = people.filter(
    person =>
      String(person.name || "").trim().toLowerCase() === normalized
  );

  const actingExact = exact.find(
    person => person.known_for_department === "Acting"
  );

  if (actingExact) return actingExact;

  const acting = people.find(
    person => person.known_for_department === "Acting"
  );

  if (acting) return acting;

  return exact[0] || people[0];
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

    return (
      Number(b.vote_count || 0) -
      Number(a.vote_count || 0)
    );
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

function isUsableConnectionMovie(movie) {
  if (!movie) return false;

  const character = String(movie.character || "").trim();

  if (/^self\b/i.test(character)) {
    return false;
  }

  if (/archive footage/i.test(character)) {
    return false;
  }

  if (
    Array.isArray(movie.genre_ids) &&
    movie.genre_ids.includes(99)
  ) {
    return false;
  }

  return true;
}

function isUsableConnectionPerson(person) {
  if (!person) return false;

  const character = String(person.character || "").trim();

  if (/^self\b/i.test(character)) {
    return false;
  }

  if (/archive footage/i.test(character)) {
    return false;
  }

  if (
    person.known_for_department &&
    person.known_for_department !== "Acting"
  ) {
    return false;
  }

  return true;
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

  const movieCache = new Map();
  const personCreditCache = new Map();

  async function getCachedCredits(personId) {
    if (!personCreditCache.has(personId)) {
      personCreditCache.set(
        personId,
        await getMovieCredits(personId)
      );
    }

    return personCreditCache.get(personId);
  }

  async function getCachedCast(movieId) {
    if (!movieCache.has(movieId)) {
      movieCache.set(
        movieId,
        await getMovieCast(movieId)
      );
    }

    return movieCache.get(movieId);
  }

  const queue = [
    {
      actor: from,
      distance: 0,
      path: [makePathActor(from)],
    },
  ];

  const visited = new Set([from.id]);
  const MAX_DEGREES = 6;

  while (queue.length > 0) {
    const current = queue.shift();

    if (current.distance >= MAX_DEGREES) {
      continue;
    }

    const credits = await getCachedCredits(current.actor.id);

    const movies = sortMovies(
      credits
        .filter(movie => movie && movie.id)
        .filter(isUsableConnectionMovie)
    ).slice(0, 50);

    for (const movie of movies) {
      const cast = await getCachedCast(movie.id);

      const destination = cast.find(person => {
        if (!person || person.id !== to.id) {
          return false;
        }

        return isUsableConnectionPerson(person);
      });

      if (destination) {
        const nextDistance = current.distance + 1;

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

      const orderedCast = [...cast].sort((a, b) => {
        return (
          Number(b.popularity || 0) -
          Number(a.popularity || 0)
        );
      });

      for (const person of orderedCast) {
        if (!person || !person.id || !person.name) {
          continue;
        }

        if (person.id === from.id) {
          continue;
        }

        if (!isUsableConnectionPerson(person)) {
          continue;
        }

        const nextDistance = current.distance + 1;

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

    if (type === "movie" && id) {
      const movie = await tmdb(
        `/movie/${encodeURIComponent(id)}?language=en-US`
      );

      return res.status(200).json(movie);
    }

    if (type === "person" && id) {
      const person = await tmdb(
        `/person/${encodeURIComponent(id)}?language=en-US`
      );

      return res.status(200).json(person);
    }

    if (type === "movie-details" && id) {
      const movie = await tmdb(
        `/movie/${encodeURIComponent(id)}?language=en-US&append_to_response=credits,videos`
      );

      return res.status(200).json(movie);
    }

    if (type === "person-details" && id) {
      const person = await tmdb(
        `/person/${encodeURIComponent(id)}?language=en-US&append_to_response=combined_credits`
      );

      return res.status(200).json(person);
    }

    const searchTerm = q || "";

    const [movieData, personData] = await Promise.all([
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

    const movies = Array.isArray(movieData.results)
      ? movieData.results
      : [];

    const people = Array.isArray(personData.results)
      ? personData.results
      : [];

    const movieResults = movies.map(movie => ({
      ...movie,
      result_type: "movie",
      display_title:
        movie.title ||
        movie.original_title ||
        "Untitled",
      year: yearFromDate(movie.release_date),
    }));

    const personResults = people.map(person => ({
      ...person,
      result_type: "person",
      display_title: person.name || "Unknown",
    }));

    const results = [
      ...movieResults,
      ...personResults,
    ];

    return res.status(200).json({
      results,
      movies,
      people,
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
