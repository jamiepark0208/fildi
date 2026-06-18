import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { logger } from "../lib/logger";

interface AppError extends Error {
  status?: number;
  statusCode?: number;
  code?: string;
}

export const errorHandler: ErrorRequestHandler = (err: AppError, req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({
      code: "VALIDATION_ERROR",
      message: err.errors[0]?.message ?? "Invalid request data",
      errors: err.errors,
    });
    return;
  }

  const status = err.status ?? err.statusCode ?? 500;

  if (status >= 500) {
    logger.error({ err, req: { method: req.method, url: req.url } }, "Unhandled server error");
  }

  res.status(status).json({
    code: err.code ?? (status === 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR"),
    message: status === 500 ? "Server error" : (err.message || "Request error"),
  });
};
