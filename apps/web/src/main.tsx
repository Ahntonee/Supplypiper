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
import { Approval } from "./pages/Approval";
import { Compare } from "./pages/Compare";
import { OrderDetailPage, Orders } from "./pages/Orders";
import { Publish, RequestDetail, Suppliers } from "./pages/RequestFlow";
import { SupplierAgents } from "./pages/SupplierAgents";
import { Inbox, InboxRequest } from "./pages/SupplierInbox";
import { Catalogue as SupplierCatalogue, SupplierProfile } from "./pages/SupplierSetup";
import { NewRequest, Overview, Requests } from "./pages/Workspace";

const queryClient: QueryClient = new QueryClient({
  // An expired session on any call sends the user back through the sign-in guard.
  queryCache: new QueryCache({ onError: (e) => { if (e instanceof ApiError && e.status === 401) queryClient.invalidateQueries({ queryKey: ["me"] }); } }),
  defaultOptions: { queries: { retry: (n, e) => !(e instanceof ApiError && e.status < 500 && e.status !== 0) && n < 2, refetchOnWindowFocus: false } },
});

function RouteError() {
  return (
    <main className="grid min-h-svh place-items-center p-8"><div className="max-w-md">
      <h1 className="text-[28px] font-semibold">Something went wrong on this page</h1>
      <p className="mt-2 text-text-muted">Your work on the server is safe. Reload to try again, or go back to the overview.</p>
      <p className="mt-4 flex gap-4"><a className="font-medium text-primary underline" href="" onClick={(e) => { e.preventDefault(); location.reload(); }}>Reload</a><a className="font-medium text-primary underline" href="/app">Overview</a></p>
    </div></main>
  );
}

const router = createBrowserRouter([
  { errorElement: <RouteError />, children: [
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
    { path: "requests/:id", element: <RequestDetail /> },
    { path: "requests/:id/publish", element: <Publish /> },
    { path: "requests/:id/compare", element: <Compare /> },
    { path: "approvals/:intentId", element: <Approval /> },
    { path: "orders", element: <Orders /> },
    { path: "orders/:id", element: <OrderDetailPage /> },
    { path: "suppliers", element: <Suppliers /> },
    { path: "inbox", element: <Inbox /> },
    { path: "inbox/:requestId", element: <InboxRequest /> },
    { path: "catalogue", element: <SupplierCatalogue /> },
    { path: "profile", element: <SupplierProfile /> },
    { path: "agents", element: <SupplierAgents /> },
  ] },
  { path: "*", element: <main className="grid min-h-svh place-items-center p-8"><div><h1 className="text-[28px] font-semibold">Page not found</h1><a className="text-primary underline" href="/">Go to the home page</a></div></main> },
  ] },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode><QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider></StrictMode>,
);
