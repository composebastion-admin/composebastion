import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import "./styles/main.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary title="ComposeBastion failed to start">
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>
);
