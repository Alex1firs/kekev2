import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from "typeorm";
import { User } from "./User";

@Entity("saved_locations")
export class SavedLocation {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Column()
    userId!: string;

    @ManyToOne(() => User)
    @JoinColumn({ name: "userId" })
    user!: User;

    @Column()
    name!: string; // e.g. "Home", "Office"

    @Column()
    address!: string;

    @Column({ type: "decimal", precision: 10, scale: 7 })
    lat!: number;

    @Column({ type: "decimal", precision: 10, scale: 7 })
    lng!: number;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
