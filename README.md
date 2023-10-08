# Earthquake Alert System

![Earthquake Alert System](https://github.com/mkshuvo/earthquake-alert-server/blob/0b1d888f3545f2d89715ca40fc44c5da1108bc86/Earthquake_Alert_System.jpeg?raw=true)

## Overview

The Earthquake Alert System, built with NestJS, is a project in progress aimed at providing real-time earthquake alerts. This system fetches data from a reliable earthquake API, stores it in a MongoDB database, and broadcasts the latest events in real-time using RabbitMQ.

## Features

- **Real-Time Alerts:** Receive immediate alerts about earthquake events as they happen.
- **Data Storage:** All earthquake data is stored in MongoDB for historical analysis and reporting.
- **Event Broadcasting:** Utilizes RabbitMQ to broadcast the latest earthquake events in real-time.

## Technologies Used

- **NestJS:** A progressive Node.js framework for building efficient and scalable server-side applications.
- **MongoDB:** A NoSQL database for storing earthquake data.
- **RabbitMQ:** A message broker used for real-time event broadcasting.
- **HTML, CSS, and JavaScript:** Frontend components for user interaction.

## Installation

1. Clone the repository:
2. Run the following to start
   ```bash
   docker compose up
