/**
 * LAUNCH ROUND (found by the first REAL-BROWSER run of the Stage 4 panels). The Stage 4 browser clients take the fetch function as a parameter (`fetchFn`) and call it as `input.fetchFn(url, init)`: the call then has the OPTIONS OBJECT as `this`, and the browser's own `fetch`
 * refuses that («Failed to execute 'fetch' on 'Window': Illegal invocation»). Every panel but one then showed «تعذّر الاتصال الآن» and never sent a request. The unit tests passed a mock, which has no `this` rule. Components pass THIS function instead: an arrow that calls the global `fetch` with no `this`.
 */
export const browserFetch: typeof fetch = (input, init) => fetch(input, init);
