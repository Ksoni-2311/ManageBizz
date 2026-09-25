import mongoose, { Schema, Document } from "mongoose";
import { UserRole } from "@nexusops/shared-types";

export interface IUser extends Document {
  name: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  orgId: string;
  sessionVersion: number;
  createdAt: Date;
}

const UserSchema = new Schema<IUser>({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, index: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: Object.values(UserRole), default: UserRole.MEMBER },
  orgId: { type: String, required: true },
  sessionVersion: { type: Number, required: true, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

export const UserModel = mongoose.model<IUser>("User", UserSchema);
