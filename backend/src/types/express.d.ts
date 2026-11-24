import type { User as PrismaUser } from "@prisma/client";

// Passport puts the deserialized Prisma user on req.user (see config/passport.ts).
declare global {
  namespace Express {
    interface User
      extends Pick<PrismaUser, "id" | "email" | "name" | "photoUrl" | "googleId"> {}
  }
}

export {};
