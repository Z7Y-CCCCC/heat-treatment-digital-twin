'use strict';

function timeoutError(operation, timeoutMs) {
    const error = new Error(`MySQL ${operation} exceeded ${timeoutMs}ms`);
    error.code = 'MYSQL_OPERATION_TIMEOUT';
    return error;
}

function acquireMysqlConnection(pool, timeoutMs) {
    return new Promise((resolve, reject) => {
        let active = true;
        const timer = setTimeout(() => {
            active = false;
            reject(timeoutError('connection acquisition', timeoutMs));
        }, timeoutMs);
        Promise.resolve().then(() => pool.getConnection()).then(connection => {
            // This checkout belonged to the expired request, so it cannot be
            // handed to that request or leak a slot in the pool.
            if (!active) {
                try { connection.release(); }
                catch (error) {
                    try { connection.destroy(); } catch {}
                    console.warn('[DB] Late MySQL checkout cleanup failed:', error.message);
                }
                return;
            }
            active = false;
            clearTimeout(timer);
            resolve(connection);
        }, error => {
            if (!active) return;
            active = false;
            clearTimeout(timer);
            if (/queue limit reached/i.test(error.message || '')) error.code = 'MYSQL_CONNECTION_QUEUE_FULL';
            reject(error);
        });
    });
}

class MysqlSession {
    constructor(connection, timeoutMs, { pooled = true } = {}) {
        this.connection = connection;
        this.timeoutMs = timeoutMs;
        this.active = true;
        this.destroyed = false;
        this.pooled = pooled;
    }

    assertActive() {
        if (!this.active || this.destroyed) throw new Error('MySQL transaction/session has already ended');
    }

    deadline(operation, action, timeoutMs = this.timeoutMs) {
        this.assertActive();
        return new Promise((resolve, reject) => {
            let pending = true;
            const timer = setTimeout(() => {
                if (!pending) return;
                pending = false;
                this.active = false;
                this.destroyed = true;
                // Destroy only the connection exclusively checked out by this
                // session. A late callback can never commit or release it.
                try { this.connection.destroy(); } catch {}
                reject(timeoutError(operation, timeoutMs));
            }, timeoutMs);
            Promise.resolve().then(() => { this.assertActive(); return action(); }).then(value => {
                if (!pending) return;
                pending = false;
                clearTimeout(timer);
                resolve(value);
            }, error => {
                if (!pending) return;
                pending = false;
                clearTimeout(timer);
                if (error?.code === 'PROTOCOL_SEQUENCE_TIMEOUT') {
                    this.active = false;
                    this.destroyed = true;
                    try { this.connection.destroy(); } catch {}
                }
                reject(error);
            });
        });
    }

    execute(sql, params) {
        return this.deadline('statement', () => this.connection.execute({ sql, timeout: this.timeoutMs }, params));
    }

    release() {
        const wasActive = this.active;
        this.active = false;
        if (wasActive && !this.destroyed && this.pooled) {
            try { this.connection.release(); }
            catch (error) {
                this.releaseError = error;
                this.destroyed = true;
                try { this.connection.destroy(); } catch {}
                console.warn('[DB] MySQL checkout release failed:', error.message);
            }
        }
    }
}

module.exports = { acquireMysqlConnection, MysqlSession };
