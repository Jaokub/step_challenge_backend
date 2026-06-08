import { validationResult } from 'express-validator';

/**
 * Validation middleware factory.
 * Accepts an array of express-validator validation chains and returns
 * a middleware array that runs the validations and checks for errors.
 *
 * If validation fails, responds with a 400 status and the errors in
 * a consistent JSON format. Otherwise, proceeds to the next handler.
 *
 * @param {import('express-validator').ValidationChain[]} validations - Array of validation chains.
 * @returns {import('express').RequestHandler[]}
 *
 * @example
 * import { body } from 'express-validator';
 * import { validate } from '../middleware/validate.js';
 *
 * router.post(
 *   '/register',
 *   validate([
 *     body('email').isEmail().withMessage('Valid email is required'),
 *     body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
 *   ]),
 *   authController.register
 * );
 */
export const validate = (validations) => {
  return async (req, res, next) => {
    // Run all validations in parallel
    await Promise.all(validations.map((validation) => validation.run(req)));

    const errors = validationResult(req);

    if (errors.isEmpty()) {
      return next();
    }

    const extractedErrors = errors.array().map((err) => ({
      field: err.path,
      message: err.msg,
      value: err.value,
    }));

    return res.status(400).json({
      success: false,
      message: 'Validation failed.',
      errors: extractedErrors,
    });
  };
};
