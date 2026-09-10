import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./globals.css";
import "./chat-controls.css";

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
