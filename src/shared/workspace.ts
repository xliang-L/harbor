export const project = new URLSearchParams(location.search).get("project") || "default";
// Keep project context on downloads and iframe URLs as well as API requests.
const originalFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  if (typeof input === "string" && input.startsWith("/api/")) {
    const u = new URL(input, location.origin);
    u.searchParams.set("project", project);
    return originalFetch(u, {
      ...init,
      headers: { ...init?.headers, "X-Harbor-Project": project },
    });
  }
  return originalFetch(input, init);
};
