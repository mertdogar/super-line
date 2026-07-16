import { execSync } from 'node:child_process'
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'
import type { GlobalSetupContext } from 'vitest/node'

// One broker per image for the whole integration lane. The per-file boots this replaces were
// the lane's dominant wall-clock AND its flake source: every boot loaded the Docker daemon
// exactly while the next file's delivery budgets were counting down. rabbitmq-reconnect keeps
// its own container — it restarts it mid-test.
export default async function ({ provide }: GlobalSetupContext) {
  try {
    execSync('docker info', { stdio: 'ignore' })
  } catch {
    return // no Docker: provide nothing; the files skip themselves via their own guard
  }

  const started: StartedTestContainer[] = []
  const [redis, rabbit] = await Promise.all([
    new GenericContainer('redis:7').withExposedPorts(6379).start(),
    // RabbitMQ boots slower than Redis — wait for the log line, generous startup timeout.
    // A custom default user is needed: the built-in `guest` is refused over the mapped port
    // (RabbitMQ restricts `guest` to loopback connections).
    new GenericContainer('rabbitmq:4')
      .withExposedPorts(5672)
      .withEnvironment({ RABBITMQ_DEFAULT_USER: 'superline', RABBITMQ_DEFAULT_PASS: 'superline' })
      .withWaitStrategy(Wait.forLogMessage('Server startup complete'))
      .withStartupTimeout(180_000)
      .start(),
  ])
  started.push(redis, rabbit)

  provide('redisUrl', `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`)
  provide('amqpUrl', `amqp://superline:superline@${rabbit.getHost()}:${rabbit.getMappedPort(5672)}`)

  return async () => {
    await Promise.all(started.map((c) => c.stop()))
  }
}

declare module 'vitest' {
  interface ProvidedContext {
    redisUrl: string
    amqpUrl: string
  }
}
