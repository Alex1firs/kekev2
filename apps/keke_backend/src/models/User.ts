import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from "typeorm";

export enum UserRole {
    PASSENGER = "passenger",
    DRIVER = "driver",
    ADMIN = "admin"
}

@Entity()
export class User {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Column({ unique: true })
    email!: string;

    @Column({ nullable: true })
    phone!: string;

    @Column()
    password!: string;

    @Column()
    firstName!: string;

    @Column()
    lastName!: string;

    @Column({ type: "enum", enum: UserRole, default: UserRole.PASSENGER })
    role!: UserRole;

    @Column({ default: false })
    emailVerified!: boolean;

    @Column({ type: "timestamp", nullable: true })
    emailVerifiedAt!: Date | null;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
