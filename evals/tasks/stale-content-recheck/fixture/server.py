import socket

DEFAULT_PORT = 8080
PORT = int(__import__('os').environ.get('PORT', DEFAULT_PORT))


def serve():
    return socket.socket()
