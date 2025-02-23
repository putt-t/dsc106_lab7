mapboxgl.accessToken = "pk.eyJ1IjoibnRhbGVvbmdwb25nIiwiYSI6ImNtNDZsbnY4MzE3cm4yanB6MDBlaGRqOG8ifQ.SFEZqtC8YO-R4L3PJAUJbg";

let circles;
let stations = [];
let trips;
let timeFilter = -1;
let filteredTrips = [];
let filteredArrivals = new Map();
let filteredDepartures = new Map();
let filteredStations = [];
let departuresByMinute = Array.from({ length: 1440 }, () => []);
let arrivalsByMinute = Array.from({ length: 1440 }, () => []);
let stationFlow = d3.scaleQuantize()
    .domain([0, 1])
    .range([0, 0.5, 1]);

const svg = d3.select('#map').select('svg');

const map = new mapboxgl.Map({
    container: "map",
    style: "mapbox://styles/mapbox/streets-v12",
    center: [-71.09415, 42.36027],
    zoom: 12,
    minZoom: 5,
    maxZoom: 18,
});

const timeSlider = document.getElementById("time-slider");
const selectedTime = document.getElementById("selected-time");
const anyTimeLabel = document.getElementById("any-time");

function formatTime(minutes) {
    const date = new Date(0, 0, 0, Math.floor(minutes / 60), minutes % 60);
    return date.toLocaleString("en-US", { timeStyle: "short" });
}

function minutesSinceMidnight(date) {
    return date.getHours() * 60 + date.getMinutes();
}

function updateTimeDisplay() {
    timeFilter = Number(timeSlider.value);
    if (timeFilter === -1) {
        selectedTime.textContent = "";
        anyTimeLabel.style.display = "block";
    } else {
        selectedTime.textContent = formatTime(timeFilter);
        anyTimeLabel.style.display = "none";
    }
    if (trips) {
        filterTripsbyTime();
    }
}

function filterTripsbyTime() {
    if (timeFilter === -1) {
        filteredDepartures = d3.rollup(
            departuresByMinute.flat(),
            v => v.length,
            d => d.start_station_id
        );
        filteredArrivals = d3.rollup(
            arrivalsByMinute.flat(),
            v => v.length,
            d => d.end_station_id
        );
    } else {
        filteredDepartures = d3.rollup(
            filterByMinute(departuresByMinute, timeFilter),
            v => v.length,
            d => d.start_station_id
        );
        filteredArrivals = d3.rollup(
            filterByMinute(arrivalsByMinute, timeFilter),
            v => v.length,
            d => d.end_station_id
        );
    }

    filteredStations = stations.map(station => {
        const clonedStation = { ...station };
        const id = clonedStation.short_name;

        clonedStation.departures = filteredDepartures.get(id) ?? 0;
        clonedStation.arrivals = filteredArrivals.get(id) ?? 0;
        clonedStation.totalTraffic = clonedStation.departures + clonedStation.arrivals;
        clonedStation.departureRatio = clonedStation.totalTraffic > 0
            ? clonedStation.departures / clonedStation.totalTraffic
            : 0.5;
        clonedStation.flowDescription =
            clonedStation.departureRatio > 0.6 ? "More departures" :
                clonedStation.departureRatio < 0.4 ? "More arrivals" :
                    "Balanced traffic";

        return clonedStation;
    });

    const maxTraffic = d3.max(filteredStations, d => d.totalTraffic);
    const radiusScale = d3.scaleSqrt()
        .domain([0, Math.max(1, maxTraffic)])
        .range(timeFilter === -1 ? [3, 15] :
            timeFilter >= 1380 || timeFilter <= 60 ? [3, 10] : [5, 20]);

    circles
        .data(filteredStations)
        .transition()
        .duration(300)
        .attr("r", d => radiusScale(d.totalTraffic))
        .style("--departure-ratio", d => stationFlow(d.departureRatio));

    circles.select("title")
        .text(d =>
            `${d.short_name}: ${d.totalTraffic} trips ` +
            `(${d.departures} departures, ${d.arrivals} arrivals)`
        );

    updatePositions();
}

timeSlider.addEventListener("input", updateTimeDisplay);

function getCoords(station) {
    const point = new mapboxgl.LngLat(+station.lon, +station.lat);
    const { x, y } = map.project(point);
    return { cx: x, cy: y };
}

function updatePositions() {
    circles
        .attr("cx", (d) => getCoords(d).cx)
        .attr("cy", (d) => getCoords(d).cy);
}

function filterByMinute(tripsByMinute, minute) {
    // Use a smaller window near midnight
    let windowSize = minute >= 1380 || minute <= 60 ? 30 : 60;
    let minMinute = (minute - windowSize + 1440) % 1440;
    let maxMinute = (minute + windowSize) % 1440;

    if (minMinute > maxMinute) {
        let beforeMidnight = tripsByMinute.slice(minMinute);
        let afterMidnight = tripsByMinute.slice(0, maxMinute + 1);
        return beforeMidnight.concat(afterMidnight).flat();
    } else {
        return tripsByMinute.slice(minMinute, maxMinute + 1).flat();
    }
}

map.on("load", () => {
    map.addSource("boston_route", {
        type: "geojson",
        data: "https://bostonopendata-boston.opendata.arcgis.com/datasets/boston::existing-bike-network-2022.geojson?...",
    });

    map.addLayer({
        id: "bike-lanes",
        type: "line",
        source: "boston_route",
        paint: {
            "line-color": "#32D400",
            "line-width": 5,
            "line-opacity": 0.6,
        },
    });

    const jsonurl = "https://dsc106.com/labs/lab07/data/bluebikes-stations.json";
    d3.json(jsonurl)
        .then((jsonData) => {
            stations = jsonData.data.stations;
            const tripsURL = "https://dsc106.com/labs/lab07/data/bluebikes-traffic-2024-03.csv";
            d3.csv(tripsURL, d3.autoType)
                .then((data) => {
                    trips = data;
                    trips.forEach((trip) => {
                        trip.started_at = new Date(trip.started_at);
                        trip.ended_at = new Date(trip.ended_at);

                        let startedMinutes = minutesSinceMidnight(trip.started_at);
                        let endedMinutes = minutesSinceMidnight(trip.ended_at);

                        departuresByMinute[startedMinutes].push(trip);
                        arrivalsByMinute[endedMinutes].push(trip);
                    });

                    let departures = d3.rollup(
                        trips,
                        (v) => v.length,
                        (d) => d.start_station_id
                    );
                    let arrivals = d3.rollup(
                        trips,
                        (v) => v.length,
                        (d) => d.end_station_id
                    );

                    stations = stations.map((station) => {
                        let id = station.short_name;
                        station.departures = departures.get(id) ?? 0;
                        station.arrivals = arrivals.get(id) ?? 0;
                        station.totalTraffic = station.departures + station.arrivals;
                        return station;
                    });

                    const radiusScale = d3
                        .scaleSqrt()
                        .domain([0, d3.max(stations, (d) => d.totalTraffic)])
                        .range([3, 15]);

                    circles = svg
                        .selectAll("circle")
                        .data(stations)
                        .enter()
                        .append("circle")
                        .attr("r", d => radiusScale(d.totalTraffic))
                        .style("--departure-ratio", d => stationFlow(d.departures / d.totalTraffic))
                        .attr("stroke", "white")
                        .attr("stroke-width", 1)
                        .attr("opacity", 0.8);

                    circles.each(function (d) {
                        d3.select(this)
                            .append("title")
                            .text(
                                `${d.short_name}: ${d.totalTraffic} trips (${d.departures} ` +
                                `departures, ${d.arrivals} arrivals)`
                            );
                    });

                    updatePositions();

                    map.on("move", updatePositions);
                    map.on("zoom", updatePositions);
                    map.on("resize", updatePositions);
                    map.on("moveend", updatePositions);

                    updateTimeDisplay();
                    filterTripsbyTime();
                })
                .catch((error) => {
                    console.error("Error loading CSV:", error);
                });
        })
        .catch((error) => {
            console.error("Error loading JSON:", error);
        });
});
