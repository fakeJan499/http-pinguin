import { initializeApp, type FirebaseOptions } from 'firebase/app';
import { getDatabase, onValue, ref } from 'firebase/database';
import { BehaviorSubject, exhaustMap, map, merge, switchMap, tap, timer } from 'rxjs';

declare module 'bun' {
    interface Env {
        FIREBASE_API_KEY: string;
        FIREBASE_DB_URL: string;
        FIREBASE_DB_PING_DEF_TABLE_PATH: string;
        LOG: 'ALL' | 'ERROR' | 'NONE';
    }
}

interface PingPath {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    path: string;
    intervalMinutes: number;
    headers?: Record<string, string>;
}

const watchPaths = () => {
    const firebaseConfig: FirebaseOptions = {
        apiKey: Bun.env.FIREBASE_API_KEY,
        databaseURL: Bun.env.FIREBASE_DB_URL,
    };
    const app = initializeApp(firebaseConfig);
    const database = getDatabase(app);
    const pingConfigPathsRef = ref(database, Bun.env.FIREBASE_DB_PING_DEF_TABLE_PATH);

    const pingPathSubject = new BehaviorSubject<PingPath[]>([]);

    onValue(pingConfigPathsRef, snapshot => {
        pingPathSubject.next(snapshot.val() ?? []);
    });

    return pingPathSubject.asObservable();
};

const isPingPathValid = (pingPath: PingPath) =>
    pingPath.intervalMinutes > 0 &&
    ['GET', 'POST', 'PUT', 'DELETE'].includes(pingPath.method) &&
    /^https?:\/\//.test(pingPath.path) &&
    (!pingPath.headers ||
        Object.entries(pingPath.headers).every(entry =>
            entry.every(x => typeof x === 'string' && !!x),
        ));

const startPinging = (pingPaths: PingPath[]) =>
    merge(...pingPaths.map(pingPath => startContinuousPing(pingPath)));

const startContinuousPing = (pingPath: PingPath) =>
    timer(0, pingPath.intervalMinutes * 60_000).pipe(
        exhaustMap(() =>
            fetch(pingPath.path, { method: pingPath.method, headers: pingPath.headers }),
        ),
        tap(logRequestResult),
    );

const logRequestResult = (response: Response) => {
    if (Bun.env.LOG === 'NONE' || (Bun.env.LOG === 'ERROR' && response.ok)) {
        return;
    }

    console.log(`[${getLogTimestamp()}] {${response.status}} ${response.url}`);
};

const getLogTimestamp = () => {
    const date = new Date();
    const isoDate = date.toISOString();
    const offset = date.getTimezoneOffset() / 60;
    const offsetString = offset < 0 ? `-${Math.abs(offset)}` : `+${offset}`;

    return `${isoDate}${offsetString}`;
};

watchPaths()
    .pipe(
        map(pingPaths => pingPaths.filter(isPingPathValid)),
        switchMap(pingPaths => startPinging(pingPaths)),
    )
    .subscribe();
