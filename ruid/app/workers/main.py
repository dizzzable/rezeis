import asyncio
import logging
import signal

from taskiq_redis import ListQueueBroker, RedisAsyncResultBackend

from app.core.config import get_settings

settings = get_settings()
logger = logging.getLogger("ruid-worker")

result_backend: RedisAsyncResultBackend = RedisAsyncResultBackend(redis_url=settings.redis_url)
broker: ListQueueBroker = ListQueueBroker(url=settings.redis_url).with_result_backend(result_backend)


def configure_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )


async def wait_for_shutdown_signal() -> None:
    loop = asyncio.get_running_loop()
    shutdown_event = asyncio.Event()

    for current_signal in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(current_signal, shutdown_event.set)

    await shutdown_event.wait()


async def run_worker() -> None:
    configure_logging()
    logger.info("Starting RUID worker context")
    await broker.startup()
    logger.info("RUID worker context started")

    try:
        await wait_for_shutdown_signal()
    finally:
        logger.info("Stopping RUID worker context")
        await broker.shutdown()
        logger.info("RUID worker context stopped")


if __name__ == "__main__":
    asyncio.run(run_worker())
