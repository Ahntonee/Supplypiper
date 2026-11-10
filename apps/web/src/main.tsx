import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./styles.css";
import { ApiError } from "./api";
import { Shell } from "./components/Shell";
import { DevInbox, Login, Register, Verify } from "./pages/Auth";
import Catalogue from "./pages/Catalogue";
import Home from "./pages/Home";
import { NewRequest, Overview, Requests } from "./pages/Workspace";

const queryClient: QueryClient = new QueryClient({
  // An expired session on any call sends the user back through the sign-in guard.
  queryCache: new QueryCache({ onError: (e) => { if (e instanceof ApiError && e.status === 401) queryClient.invalidateQueries({ queryKey: ["me"] }); } }),
  defaultOptions: { queries: { retry: (n, e) => !(e instanceof ApiError && e.status < 500 && e.status !== 0) && n < 2, refetchOnWindowFocus: false } },
});

const router = createBrowserRouter([
  { path: "/", element: <Home /> },
  { path: "/login", element: <Login /> },
  { path: "/register", element: <Register /> },
  { path: "/verify", element: <Verify /> },
  { path: "/dev/inbox", element: <DevInbox /> },
  { path: "/design", element: <Catalogue /> },
  { path: "/app", element: <Shell />, children: [
    { index: true, element: <Overview /> },
    { path: "requests", element: <Requests /> },
    { path: "requests/new", element: <NewRequest /> },
  ] },
  { path: "*", element: <main className="grid min-h-svh place-items-center p-8"><div><h1 className="text-[28px] font-semibold">Page not found</h1><a className="text-primary underline" href="/">Go to the home page</a></div></main> },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode><QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider></StrictMode>,
);
