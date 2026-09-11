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

  async function findActor(name) {
    const data = await tmdb(
      `/search/person?query=${encodeURIComponent(name)}&language=en-US`
    );

    if (!data.results || data.results.length === 0) {
      return null;
    }

    const exact = data.results.find(
      person =>
        person.name &&
        person.name.toLowerCase() === name.toLowerCase()
    );

    return exact || data.results[0];
  }

  /*
   * =========================================================
   * REAL ACTING CREDIT FILTER
   * =========================================================
   */

  function isRealActingCredit(credit) {
    if (!credit) return false;

    const character = String(
      credit.character || ""
    ).trim().toLowerCase();

    if (!character) return false;

    /*
     * Exclude documentaries.
     */
    if (
      Array.isArray(credit.genre_ids) &&
      credit.genre_ids.includes(99)
    ) {
      return false;
    }

    /*
     * Exclude Self / Himself / Herself / Themselves
     * and archive footage.
     */
    const excludedCharacters = new Set([
      "self",
      "himself",
      "herself",
      "themselves",
      "archive footage",
      "archive footage (uncredited)",
      "archive footage (archive)"
    ]);

    if (excludedCharacters.has(character)) {
      return false;
    }

    if (character.includes("archive footage")) {
      return false;
    }

    /*
     * Don't use obvious interview / documentary appearances.
     */
    if (
      character === "interviewee" ||
      character === "interviewer" ||
      character === "as himself" ||
      character === "as herself" ||
      character === "as self"
    ) {
      return false;
    }

    return true;
  }

  function movieData(movie) {
    return {
      id: movie.id,
      title: movie.title,
      year: movie.release_date
        ? movie.release_date.substring(0, 4)
        : ""
    };
  }

  function personData(person) {
    return {
      id: person.id,
      name: person.name
    };
  }

  /*
   * =========================================================
   * SIX DEGREES HELPERS
   * =========================================================
   */

  const actorCreditCache = new Map();
  const movieCastCache = new Map();

  async function getActorMovies(actorId) {
    if (actorCreditCache.has(actorId)) {
      return actorCreditCache.get(actorId);
    }

    const data = await tmdb(
      `/person/${actorId}/movie_credits?language=en-US`
    );

    const movies = (data.cast || []).filter(
      isRealActingCredit
    );

    actorCreditCache.set(actorId, movies);

    return movies;
  }

  async function getMovieCast(movieId) {
    if (movieCastCache.has(movieId)) {
      return movieCastCache.get(movieId);
    }

    try {
      const data = await tmdb(
        `/movie/${movieId}/credits?language=en-US`
      );

      const cast = (data.cast || []).filter(
        isRealActingCredit
      );

      movieCastCache.set(movieId, cast);

      return cast;
    } catch {
      movieCastCache.set(movieId, []);
      return [];
    }
  }

  /*
   * =========================================================
   * FIND DIRECT MOVIE CONNECTION
   * =========================================================
   */

  async function findSharedMovie(actorA, actorB) {
    const [moviesA, moviesB] = await Promise.all([
      getActorMovies(actorA.id),
      getActorMovies(actorB.id)
    ]);

    const moviesBMap = new Map();

    for (const movie of moviesB) {
      moviesBMap.set(movie.id, movie);
    }

    const shared = moviesA.filter(movie =>
      moviesBMap.has(movie.id)
    );

    if (shared.length === 0) {
      return null;
    }

    shared.sort(
      (a, b) =>
        (b.popularity || 0) -
        (a.popularity || 0)
    );

    return shared[0];
  }

  /*
   * =========================================================
   * SIX DEGREES BREADTH-FIRST SEARCH
   *
   * Actor
   *   ↓
   * Movie
   *   ↓
   * Actor
   *   ↓
   * Movie
   *   ↓
   * Actor
   *
   * Maximum: 6 actor-to-actor connections.
   * =========================================================
   */

  async function findSixDegrees(actorA, actorB) {
    /*
     * First check for a direct connection.
     */
    const directMovie = await findSharedMovie(
      actorA,
      actorB
    );

    if (directMovie) {
      return {
        distance: 1,
        path: [
          {
            person: personData(actorA)
          },
          {
            person: personData(actorB),
            movie: movieData(directMovie)
          }
        ]
      };
    }

    /*
     * Each queue item represents an actor and the path
     * used to reach that actor.
     */
    let frontier = [
      {
        person: actorA,
        path: [
          {
            person: personData(actorA)
          }
        ]
      }
    ];

    const visitedActors = new Set([
      actorA.id
    ]);

    /*
     * Maximum six actor connections.
     */
    const MAX_DEGREES = 6;

    /*
     * Prevent the search from exploding into thousands
     * of TMDB requests.
     */
    const MAX_MOVIES_PER_ACTOR = 30;

    const MAX_CAST_PER_MOVIE = 60;

    for (
      let depth = 1;
      depth <= MAX_DEGREES;
      depth++
    ) {
      const nextFrontier = [];

      /*
       * Get movie credits for every actor currently
       * being examined.
       */
      const actorMovieResults =
        await Promise.all(
          frontier.map(async node => {
            try {
              const movies = await getActorMovies(
                node.person.id
              );

              /*
               * Popular movies first.
               */
              movies.sort(
                (a, b) =>
                  (b.popularity || 0) -
                  (a.popularity || 0)
              );

              return {
                node,
                movies: movies.slice(
                  0,
                  MAX_MOVIES_PER_ACTOR
                )
              };
            } catch {
              return {
                node,
                movies: []
              };
            }
          })
        );

      /*
       * Collect unique movies across the frontier.
       */
      const movieMap = new Map();

      for (const result of actorMovieResults) {
        for (const movie of result.movies) {
          if (!movieMap.has(movie.id)) {
            movieMap.set(movie.id, {
              movie,
              parentNodes: []
            });
          }

          movieMap
            .get(movie.id)
            .parentNodes
            .push(result.node);
        }
      }

      /*
       * Get movie casts in parallel.
       */
      const movieResults =
        await Promise.all(
          [...movieMap.values()].map(
            async item => {
              const cast =
                await getMovieCast(
                  item.movie.id
                );

              return {
                ...item,
                cast:
                  cast.slice(
                    0,
                    MAX_CAST_PER_MOVIE
                  )
              };
            }
          )
        );

      /*
       * Examine every cast member as a possible
       * next actor in the chain.
       */
      for (const result of movieResults) {
        for (const castMember of result.cast) {
          /*
           * Have we reached the target?
           */
          if (
            castMember.id === actorB.id
          ) {
            const parent =
              result.parentNodes[0];

            return {
              distance: depth,
              path: [
                ...parent.path,
                {
                  person:
                    personData(actorB),
                  movie:
                    movieData(result.movie)
                }
              ]
            };
          }

          /*
           * Don't revisit an actor.
           */
          if (
            visitedActors.has(
              castMember.id
            )
          ) {
            continue;
          }

          /*
           * Add actor to the next search level.
           */
          visitedActors.add(
            castMember.id
          );

          const parent =
            result.parentNodes[0];

          nextFrontier.push({
            person: {
              id: castMember.id,
              name: castMember.name
            },

            path: [
              ...parent.path,

              {
                person: personData(
                  castMember
                ),

                movie:
                  movieData(result.movie)
              }
            ]
          });
        }
      }

      /*
       * No more actors to search.
       */
      if (
        nextFrontier.length === 0
      ) {
        break;
      }

      /*
       * Keep the frontier manageable.
       *
       * More popular actors are searched first.
       */
      nextFrontier.sort(
        (a, b) =>
          (b.person.popularity || 0) -
          (a.person.popularity || 0)
      );

      /*
       * Keep the search from becoming enormous.
       */
      frontier =
        nextFrontier.slice(0, 150);
    }

    return null;
  }

  /*
   * =========================================================
   * SIX DEGREES API
   * =========================================================
   */

  if (type === "degrees") {
    try {
      if (!from || !to) {
        return res.status(400).json({
          error: "Enter two actors."
        });
      }

      const [actorA, actorB] =
        await Promise.all([
          findActor(from),
          findActor(to)
        ]);

      if (!actorA) {
        return res.status(404).json({
          error:
            `Actor "${from}" was not found.`
        });
      }

      if (!actorB) {
        return res.status(404).json({
          error:
            `Actor "${to}" was not found.`
        });
      }

      if (
        actorA.id === actorB.id
      ) {
        return res.status(400).json({
          error:
            "Choose two different actors."
        });
      }

      const result =
        await findSixDegrees(
          actorA,
          actorB
        );

      if (!result) {
        return res.status(404).json({
          error:
            `Reelwise could not find a connection between ${actorA.name} and ${actorB.name} within six degrees.`
        });
      }

      return res.status(200).json({
        from: personData(actorA),
        to: personData(actorB),
        distance: result.distance,
        path: result.path
      });

    } catch (error) {
      console.error(
        "Six Degrees error:",
        error
      );

      return res.status(500).json({
        error:
          "Six Degrees search failed."
      });
    }
  }

  /*
   * =========================================================
   * NORMAL REELWISE SEARCH
   * =========================================================
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
    console.error(
      "Reelwise search error:",
      error
    );

    return res.status(500).json({
      error: "Search failed."
    });
  }
}
