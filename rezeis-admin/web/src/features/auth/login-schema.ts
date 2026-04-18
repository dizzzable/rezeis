import { z } from 'zod'

export function createLoginSchema() {
  return z.object({
    login: z
      .string()
      .trim()
      .min(1, 'auth.loginPage.form.errors.loginRequired')
      .pipe(
        z
          .string()
          .min(3, 'auth.loginPage.form.errors.loginTooShort')
          .max(64, 'auth.loginPage.form.errors.loginTooLong')
          .regex(/^[A-Za-z0-9._-]+$/, 'auth.loginPage.form.errors.loginInvalidFormat'),
      ),
    password: z.string().min(1, 'auth.loginPage.form.errors.passwordRequired'),
  })
}
