import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "./App.js";

describe("web authenticated shell", () => {
  it("renders a sign-in-required state with no private content or token persistence", () => {
    const markup = renderToStaticMarkup(<App baseUrl="https://api.example" />);
    expect(markup).toContain("Sign-in required");
    expect(markup).toContain("Development access token");
    expect(markup).toContain('type="password"');
    expect(markup).not.toContain("Synthetic Alice");
    expect(markup).not.toContain("localStorage");
  });
});
