import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { ApiError } from "./api.ts";
import { Layout, RouteError } from "./Layout.tsx";
import { Customers } from "./pages/Customers.tsx";
import { InvoiceDetail } from "./pages/InvoiceDetail.tsx";
import { InvoiceForm } from "./pages/InvoiceForm.tsx";
import { Invoices } from "./pages/Invoices.tsx";
import { Overview } from "./pages/Overview.tsx";
import { Review } from "./pages/Review.tsx";
import { SignIn } from "./pages/SignIn.tsx";
import { ToastProvider } from "./ui.tsx";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      // Retry network blips, never a definite answer like 404 or 401.
      retry: (count, err) => count < 2 && (!(err instanceof ApiError) || err.status === 0 || err.status >= 500),
    },
  },
  // Any write may change totals, payment status and sync state elsewhere: refresh what's on screen.
  mutationCache: new MutationCache({ onSettled: () => queryClient.invalidateQueries() }),
});

const router = createBrowserRouter([
  { path: "/signin", element: <SignIn /> },
  {
    element: <Layout />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <Overview /> },
      { path: "invoices", element: <Invoices /> },
      { path: "invoices/new", element: <InvoiceForm /> },
      { path: "invoices/:id", element: <InvoiceDetail /> },
      { path: "invoices/:id/edit", element: <InvoiceForm /> },
      { path: "review", element: <Review /> },
      { path: "customers", element: <Customers /> },
      { path: "*", element: <RouteError notFound /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
