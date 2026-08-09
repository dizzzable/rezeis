/**
 * The deep-link return path, end to end.
 *
 * `sign-in-page` and `oauth-buttons` navigate to `consumeReturnTo() ?? '/'` at
 * four call sites. Until this test existed, the only caller of the matching
 * `captureReturnTo` was `components/layout/auth-guard.tsx` — a component
 * imported from nowhere, still redirecting to a `/login` route the router does
 * not define. So the consumer was live, the producer was unreachable, and every
 * deep link opened while signed out landed the operator on `/` after sign-in.
 *
 * That is why these cases assert the MECHANISM (a key in sessionStorage that
 * the sign-in flow can read back) rather than "ProtectedRoute rendered a
 * redirect". A redirect assertion passes with the capture deleted.
 */
import { render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ProtectedRoute from "./protected-route";
import { consumeReturnTo } from "@/lib/return-to";

const authState = {
  isAuthenticated: false,
  isLoading: false,
  mustChangePassword: false,
  sessionError: null as Error | null,
  retrySession: (): void => {},
};

vi.mock("@/features/auth/auth-provider", () => ({
  useAuth: () => authState,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<ProtectedRoute />}>
          <Route path="/support-tickets" element={<p>tickets</p>} />
          <Route path="/" element={<p>home</p>} />
        </Route>
        <Route path="/sign-in" element={<p>sign in</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  sessionStorage.clear();
  authState.isAuthenticated = false;
  authState.isLoading = false;
  authState.mustChangePassword = false;
  authState.sessionError = null;
});

afterEach(() => {
  sessionStorage.clear();
});

describe("ProtectedRoute deep-link return target", () => {
  it("captures the full deep link so signing in can navigate back to it", async () => {
    renderAt("/support-tickets?ticket=482#note");

    await waitFor(() => {
      expect(
        consumeReturnTo(),
        "an unauthenticated deep link left nothing for the sign-in flow to read back — " +
          "sign-in-page and oauth-buttons call consumeReturnTo() at four sites, so with no " +
          "writer every deep link silently lands on / after login",
      ).toBe("/support-tickets?ticket=482#note");
    });
  });

  it("captures nothing while the session is still being verified", async () => {
    authState.isLoading = true;
    renderAt("/support-tickets?ticket=482");

    // A slow /me probe must not be mistaken for "signed out": the operator may
    // well be authenticated, and writing here would strand a stale target that
    // the NEXT sign-in would consume.
    await Promise.resolve();
    expect(consumeReturnTo()).toBeNull();
  });

  it("captures nothing when the session probe failed", async () => {
    authState.sessionError = new Error("network down");
    renderAt("/support-tickets?ticket=482");

    // This branch renders a retry card, not a redirect. Capturing here would
    // write a target no sign-in is coming to consume.
    await Promise.resolve();
    expect(consumeReturnTo()).toBeNull();
  });

  it("captures nothing for an authenticated operator", async () => {
    authState.isAuthenticated = true;
    renderAt("/support-tickets?ticket=482");

    await Promise.resolve();
    expect(consumeReturnTo()).toBeNull();
  });

  it("does not capture the site root, which would be a no-op redirect", async () => {
    renderAt("/");

    await Promise.resolve();
    expect(consumeReturnTo()).toBeNull();
  });
});
