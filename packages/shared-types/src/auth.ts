export enum UserRole {
  ADMIN = "ADMIN",
  MANAGER = "MANAGER",
  MEMBER = "MEMBER"
}

export interface UserSession {
  userId: string;
  email: string;
  role: UserRole;
  orgId: string;
}

export interface JwtPayload {
  userId: string;
  email: string;
  role: UserRole;
  orgId: string;
  iat?: number;
  exp?: number;
}
