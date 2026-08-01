import 'reflect-metadata';
import { AppDataSource } from './config/data_source';
import { Ride } from './models/Ride';
import { ParkDispatchService } from './services/park_dispatch_service';
import { DeepPartial, Repository } from 'typeorm';
function mk<T extends object>(r: Repository<T>, d: Record<string, unknown>): T { return r.create(d as DeepPartial<T>); }
/**
 * Create ONE park request, exactly as the dispatch orchestrator would when a
 * search fails. Used to test whether an arriving request alerts a dispatcher
 * who already has the app open.
 */
async function main() {
  await AppDataSource.initialize();
  ParkDispatchService.setHost({
    assignDriver: async () => ({ ok: false as const, code: 'T', message: 't' }),
    offerRideToDriver: async () => false,
    emitToRide: () => {}, emitToPark: () => {}, emitToAdmin: () => {}, notifyPassenger: () => {},
  });
  const pax: Array<{id:string}> = await AppDataSource.query(
    `SELECT id FROM "user" WHERE email='test.passenger@kekeride.ng'`);
  const rides = AppDataSource.getRepository(Ride);
  const rideId = `RIDE-ALERT-${Date.now()}`;
  await rides.save(mk(rides, {
    rideId, passengerId: pax[0].id, fare: 2100, paymentMode: 'cash', status: 'searching',
    pickupAddress: 'Arroma Junction', destinationAddress: 'Nnamdi Azikiwe Stadium',
    pickupLat: 6.2114, pickupLng: 7.0748, destinationLat: 6.22, destinationLng: 7.08,
  }));
  console.log(await ParkDispatchService.offerToPark(rideId) ? 'queued' : 'REFUSED');
  await AppDataSource.destroy();
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1);});
