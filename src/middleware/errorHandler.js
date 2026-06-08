/**
 * Global error handler middleware.
 * Catches all errors thrown or passed via next(error) and returns a
 * consistent JSON response format.
 *
 * @param {Error} err
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} _next
 */
const errorHandler = (err, req, res, _next) => {
  // Log the error in non-test environments
  if (process.env.NODE_ENV !== 'test') {
    console.error(`[ERROR] ${err.message}`);
    if (process.env.NODE_ENV === 'development') {
      console.error(err.stack);
    }
  }

  // Prisma known request error (e.g. unique constraint violation)
  if (err.code === 'P2002') {
    const target = err.meta?.target;
    return res.status(409).json({
      success: false,
      message: `A record with this ${Array.isArray(target) ? target.join(', ') : 'value'} already exists.`,
    });
  }

  // Prisma record not found
  if (err.code === 'P2025') {
    return res.status(404).json({
      success: false,
      message: err.meta?.cause || 'The requested record was not found.',
    });
  }

  // Prisma foreign key constraint failure
  if (err.code === 'P2003') {
    return res.status(400).json({
      success: false,
      message: 'Operation failed due to a related record constraint.',
    });
  }

  // JSON parse errors
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({
      success: false,
      message: 'Invalid JSON in request body.',
    });
  }

  // Payload too large
  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      success: false,
      message: 'Request body is too large.',
    });
  }

  // Custom application errors with statusCode
  if (err.statusCode) {
    return res.status(err.statusCode).json({
      success: false,
      message: err.message,
      ...(err.errors && { errors: err.errors }),
    });
  }

  // Default to 500 Internal Server Error
  const statusCode = res.statusCode !== 200 ? res.statusCode : 500;
  res.status(statusCode).json({
    success: false,
    message:
      process.env.NODE_ENV === 'production'
        ? 'An unexpected error occurred.'
        : err.message || 'An unexpected error occurred.',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};

export default errorHandler;
