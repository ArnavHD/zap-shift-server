const express = require("express");
const cors = require("cors");
require("dotenv").config();

const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);
const admin = require("firebase-admin");
const app = express();

let saveSuccessfulPayment;

const port = process.env.PORT || 5000;

app.use(cors());

app.post(
  "/stripe-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers["stripe-signature"],
        process.env.STRIPE_WEBHOOK_SECRET,
      );
    } catch (error) {
      return res.status(400).send({
        message: "Invalid Stripe signature",
      });
    }

    try {
      if (event.type === "payment_intent.succeeded") {
        console.log("Stripe payment succeeded:", event.data.object.id);

        await saveSuccessfulPayment(event.data.object);

        console.log("MongoDB payment update completed!");
      }

      res.send({ received: true });
    } catch (error) {
      console.error("Webhook error:", error);

      res.status(500).send({
        message: "Failed to process webhook",
      });
    }
  },
);

// Middleware
app.use(express.json());

const decodedKey = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString('utf8');

const serviceAccount = JSON.parse(decodedKey);

initializeApp({
  credential: cert(serviceAccount),
});

// Mongodb connection
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.rd0vmtq.mongodb.net/`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // await client.connect();

    const db = client.db("zapShiftDB");
    const usersCollection = db.collection("users");
    const parcelCollection = db.collection("parcels");
    const paymentCollection = db.collection("payments");
    const trackingCollection = db.collection("tracking");
    const riderApplicationsCollection = db.collection("riderApplications");
    const riderPayoutCollection = db.collection("riderPayouts");

    // custom middleware
    const verifyFBToken = async (req, res, next) => {
      const authHeader = req.headers.authorization;

      if (!authHeader) {
        return res.status(401).send({ message: "unauthorized access" });
      }

      const token = authHeader.split(" ")[1];
      if (!token) {
        return res.status(401).send({ message: "unauthorized access" });
      }

      // varify token
      try {
        //  const decoded = await admin.auth().varifyFBToken(token);
        const decoded = await getAuth().verifyIdToken(token);
        req.decoded = decoded;
        next();
      } catch {
        return res.status(403).send({ message: "forbidden access" });
      }
    };

    // verify admin
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      if (!user || user.role !== "admin") {
        return res.status(403).send("forbidden access");
      }
      next();
    };

    const verifyRider = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      if (!user || user.role !== "rider") {
        return res.status(403).send("forbidden access");
      }
      next();
    };

    const createTrackingEvent = (
      status,
      description,
      timestamp = new Date(),
    ) => ({
      status,
      description,
      timestamp,
    });

    await parcelCollection.createIndex({ trackingId: 1 }, { unique: true });

    await riderPayoutCollection.createIndex({ parcelId: 1 }, { unique: true });

    await riderApplicationsCollection.createIndex(
      { firebaseUid: 1 },
      { unique: true },
    );
    await trackingCollection.createIndex({
      trackingId: 1,
      timestamp: -1,
    });

    await paymentCollection.createIndex(
      { paymentIntentId: 1 },
      { unique: true },
    );

    await paymentCollection.createIndex({
      userEmail: 1,
      paidAt: -1,
    });

    saveSuccessfulPayment = async (paymentIntent) => {
      const parcelId = paymentIntent.metadata?.parcelId;

      if (!ObjectId.isValid(parcelId)) {
        throw new Error("Invalid parcel ID in payment metadata");
      }

      const parcel = await parcelCollection.findOne({
        _id: new ObjectId(parcelId),
      });

      if (!parcel) {
        throw new Error("Parcel not found");
      }

      const amountInCents = Math.round(Number(parcel.deliveryCost) * 100);

      if (
        paymentIntent.status !== "succeeded" ||
        paymentIntent.currency !== "cad" ||
        paymentIntent.amount_received !== amountInCents ||
        !Number.isSafeInteger(amountInCents) ||
        amountInCents <= 0
      ) {
        throw new Error("Payment verification failed");
      }

      const paidAt = new Date();

      const paymentRecord = {
        parcelId: parcel._id.toString(),
        trackingId: parcel.trackingId,
        parcelTitle: parcel.parcelTitle,
        userEmail: parcel.createdByEmail,
        amount: paymentIntent.amount_received / 100,
        currency: "CAD",
        paymentIntentId: paymentIntent.id,
        status: "paid",
        paidAt,
      };

      await paymentCollection.updateOne(
        { paymentIntentId: paymentIntent.id },
        { $setOnInsert: paymentRecord },
        { upsert: true },
      );

      await parcelCollection.updateOne(
        { _id: parcel._id },
        {
          $set: {
            paymentStatus: "paid",
            paymentIntentId: paymentIntent.id,
            paidAt,
          },
        },
      );

      console.log("Payment saved:", paymentIntent.id);
    };

    app.post("/rider-applications", verifyFBToken, async (req, res) => {
      try {
        const { uid, email, name } = req.decoded;

        const existingApplication = await riderApplicationsCollection.findOne({
          firebaseUid: req.decoded.uid,
        });

        if (existingApplication) {
          return res.status(409).send({
            message: "You have already submitted a rider application.",
          });
        }

        const {
          age,
          region,
          city,
          phone,
          nationalId,
          drivingLicense,
          bikeBrandModel,
          bikeRegistrationNumber,
          bikeModelYear,
          experience,
          additionalInfo,
        } = req.body;

        if (
          !Number.isInteger(age) ||
          age < 18 ||
          !region ||
          !city ||
          !phone ||
          !nationalId ||
          !drivingLicense ||
          !bikeBrandModel ||
          !bikeRegistrationNumber ||
          !Number.isInteger(bikeModelYear)
        ) {
          return res.status(400).send({
            message: "Please provide valid required information.",
          });
        }

        const application = {
          firebaseUid: uid,
          name: name || "",
          email: email || "",
          age,
          region,
          city,
          phone,
          nationalId,
          drivingLicense,
          bikeBrandModel,
          bikeRegistrationNumber,
          bikeModelYear,
          experience: experience || "",
          additionalInfo: additionalInfo || "",
          status: "pending",
          appliedAt: new Date(),
        };

        const result = await riderApplicationsCollection.insertOne(application);

        res.status(201).send({
          insertedId: result.insertedId,
          message: "Rider application submitted successfully.",
        });
        // } catch (error) {
        //   if (error.code === 11000) {
        //     return res.status(409).send({
        //       message: "You have already submitted a rider application.",
        //     });
        //   }

        //   console.error("Rider application error:", error);

        //   res.status(500).send({
        //     message: "Failed to submit rider application.",
        //   });
        // }
      } catch (error) {
        console.error("Rider application error:", error);

        if (error.code === 11000) {
          return res.status(409).send({
            message: "A duplicate database value was detected.",
          });
        }

        return res.status(500).send({
          message: "Failed to submit rider application.",
        });
      }
    });

    app.get(
      "/rider-applications/pending",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const pendingRiders = await riderApplicationsCollection
            .find(
              { status: "pending" },
              {
                projection: {
                  nationalId: 0,
                  drivingLicense: 0,
                },
              },
            )
            .sort({ appliedAt: -1, created_at: -1 })
            .toArray();

          res.status(200).send(pendingRiders);
        } catch (error) {
          console.error("Error fetching pending riders:", error);

          res.status(500).send({
            message: "Failed to fetch pending riders.",
          });
        }
      },
    );

    // assign rider apis
    app.get(
      "/admin/parcels/assignable",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const query = {
            paymentStatus: "paid",

            $expr: {
              $eq: [
                {
                  $arrayElemAt: ["$trackingHistory.status", -1],
                },
                "pending",
              ],
            },
          };

          const parcels = await parcelCollection
            .find(query)
            .sort({ createdAt: -1 })
            .toArray();

          res.send(parcels);
        } catch (error) {
          console.error("Error fetching assignable parcels:", error);

          res.status(500).send({
            message: "Failed to fetch assignable parcels",
          });
        }
      },
    );

    app.get(
      "/admin/riders/approved",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          // 1. Get approved rider applications
          const applications = await riderApplicationsCollection
            .find(
              { status: "approved" },
              {
                projection: {
                  firebaseUid: 1,
                  name: 1,
                  email: 1,
                  region: 1,
                  city: 1,
                  phone: 1,
                },
              },
            )
            .toArray();

          // 2. Get the emails of approved applicants
          const emails = applications.map((application) => application.email);

          // 3. Find users who currently have the rider role
          const riderUsers = await usersCollection
            .find({
              email: { $in: emails },
              role: "rider",
            })
            .project({ email: 1 })
            .toArray();

          // 4. Build a set of eligible rider emails
          const riderEmailSet = new Set(
            riderUsers.map((user) => user.email.toLowerCase()),
          );

          // 5. Keep only approved applicants with rider role
          const riders = applications.filter((application) =>
            riderEmailSet.has(application.email.toLowerCase()),
          );

          res.send(riders);
        } catch (error) {
          console.error("Failed to load riders:", error);

          res.status(500).send({
            message: "Failed to load approved riders",
          });
        }
      },
    );

    app.post(
      "/rider/parcels/:parcelId/cash-out",
      verifyFBToken,
      async (req, res) => {
        const { parcelId } = req.params;

        if (!ObjectId.isValid(parcelId)) {
          return res.status(400).send({
            message: "Invalid parcel ID",
          });
        }

        const riderEmail = req.decoded.email?.trim().toLowerCase();

        const riderUid = req.decoded.uid;

        if (!riderEmail || !riderUid) {
          return res.status(401).send({
            message: "Authentication required",
          });
        }

        const session = client.startSession();

        try {
          let payoutAmountInCents = 0;

          await session.withTransaction(async () => {
            // 1. Verify rider
            const riderUser = await usersCollection.findOne(
              {
                email: riderEmail,
                role: "rider",
              },
              { session },
            );

            if (!riderUser) {
              throw new Error("Rider access only");
            }

            // 2. Find completed parcel assigned to rider
            const parcel = await parcelCollection.findOne(
              {
                _id: new ObjectId(parcelId),
                paymentStatus: "paid",
                "assignedRider.firebaseUid": riderUid,
                status: {
                  $in: [
                    "delivered",
                    "serveice_center_delivered",
                    "service_center_delivered",
                  ],
                },
              },
              { session },
            );

            if (!parcel) {
              throw new Error(
                "Completed parcel not found or not assigned to you",
              );
            }

            // 3. Prevent duplicate cash-out
            if (
              parcel.riderPayoutStatus &&
              parcel.riderPayoutStatus !== "available"
            ) {
              throw new Error("Cash-out already requested or processed");
            }

            // 4. Calculate rider earnings
            if (parcel.parcelType === "document") {
              const deliveryFee = Number(parcel.deliveryCost);

              if (!Number.isFinite(deliveryFee) || deliveryFee <= 0) {
                throw new Error("Invalid delivery fee");
              }

              const feeInCents = Math.round(deliveryFee * 100);

              payoutAmountInCents = Math.round(feeInCents * 0.08);
            } else if (parcel.parcelType === "non-document") {
              const weight = Number(parcel.parcelWeight);

              if (!Number.isFinite(weight) || weight <= 0) {
                throw new Error("Invalid parcel weight");
              }

              payoutAmountInCents = Math.round(weight * 1000);
            } else {
              throw new Error("Unsupported parcel type");
            }

            if (
              !Number.isSafeInteger(payoutAmountInCents) ||
              payoutAmountInCents <= 0
            ) {
              throw new Error("Invalid payout amount");
            }

            const now = new Date();

            // 5. Atomically mark parcel payout as requested
            const updateResult = await parcelCollection.updateOne(
              {
                _id: parcel._id,
                "assignedRider.firebaseUid": riderUid,
                status: parcel.status,
                $or: [
                  {
                    riderPayoutStatus: {
                      $exists: false,
                    },
                  },
                  {
                    riderPayoutStatus: "available",
                  },
                ],
              },
              {
                $set: {
                  riderPayoutStatus: "requested",
                  riderEarningsInCents: payoutAmountInCents,
                  cashOutRequestedAt: now,
                },
              },
              { session },
            );

            if (updateResult.modifiedCount !== 1) {
              throw new Error("Cash-out request is no longer available");
            }

            // 6. Create payout record
            await riderPayoutCollection.insertOne(
              {
                parcelId: parcel._id,
                trackingId: parcel.trackingId,
                riderUid,
                riderEmail,
                amountInCents: payoutAmountInCents,
                currency: "CAD",
                status: "requested",
                requestedAt: now,
              },
              { session },
            );
          });

          return res.status(201).send({
            success: true,
            message: "Cash-out request submitted successfully",
            amount: payoutAmountInCents / 100,
            currency: "CAD",
            status: "requested",
          });
        } catch (error) {
          console.error("Cash-out error:", error);

          if (error.code === 11000) {
            return res.status(409).send({
              message: "Cash-out already requested for this parcel",
            });
          }

          return res.status(409).send({
            message: error.message || "Cash-out request failed",
          });
        } finally {
          await session.endSession();
        }
      },
    );

    app.get(
      "/rider-applications/active",
      verifyFBToken,
      verifyAdmin,
      // verifyAdmin,
      async (req, res) => {
        try {
          const riders = await riderApplicationsCollection
            .find(
              { status: "approved" },
              {
                projection: {
                  nationalId: 0,
                  drivingLicense: 0,
                },
              },
            )
            .sort({ reviewedAt: -1 })
            .toArray();

          res.send(riders);
        } catch (error) {
          console.error("Error fetching active riders:", error);

          res.status(500).send({
            message: "Failed to fetch active riders.",
          });
        }
      },
    );

    app.patch(
      "/rider-applications/:id/deactivate",
      verifyFBToken,
      verifyAdmin,
      // verifyAdmin,
      async (req, res) => {
        try {
          const { id } = req.params;

          if (!ObjectId.isValid(id)) {
            return res.status(400).send({
              message: "Invalid rider ID.",
            });
          }

          const result = await riderApplicationsCollection.updateOne(
            {
              _id: new ObjectId(id),
              status: "approved",
            },
            {
              $set: {
                status: "deactivated",
                deactivatedAt: new Date(),
                deactivatedBy: req.decoded.uid,
              },
            },
          );

          if (result.modifiedCount === 0) {
            return res.status(404).send({
              message: "Active rider not found or already deactivated.",
            });
          }

          res.send({
            message: "Rider deactivated successfully.",
            modifiedCount: result.modifiedCount,
          });
        } catch (error) {
          console.error("Rider deactivation error:", error);

          res.status(500).send({
            message: "Failed to deactivate rider.",
          });
        }
      },
    );

    app.patch(
      "/rider-applications/:id/status",
      verifyFBToken,
      verifyAdmin,
      // verifyAdmin,
      async (req, res) => {
        try {
          const { id } = req.params;
          const { status } = req.body;

          if (!ObjectId.isValid(id)) {
            return res.status(400).send({
              message: "Invalid application ID.",
            });
          }

          if (!["approved", "rejected"].includes(status)) {
            return res.status(400).send({
              message: "Invalid application status.",
            });
          }

          const applicationId = new ObjectId(id);

          // Find the pending rider application
          const application = await riderApplicationsCollection.findOne({
            _id: applicationId,
            status: "pending",
          });

          if (!application) {
            return res.status(409).send({
              message: "Application not found or already reviewed.",
            });
          }

          console.log("Application email:", application.email);

          // Find the user using the application's verified identity
          const user = await usersCollection.findOne({
            email: application.email,
          });

          console.log("Matching user:", user);

          if (!user) {
            return res.status(404).send({
              message: "Applicant's user account was not found.",
            });
          }

          const now = new Date();

          // Update both collections atomically
          const session = client.startSession();

          try {
            await session.withTransaction(async () => {
              const applicationResult =
                await riderApplicationsCollection.updateOne(
                  {
                    _id: applicationId,
                    status: "pending",
                  },
                  {
                    $set: {
                      status,
                      reviewedAt: now,
                      reviewedBy: req.decoded.uid,
                    },
                  },
                  { session },
                );

              if (applicationResult.modifiedCount !== 1) {
                throw new Error("APPLICATION_ALREADY_REVIEWED");
              }

              // Only approved applicants become riders
              if (status === "approved") {
                const userResult = await usersCollection.updateOne(
                  { _id: user._id },
                  {
                    $set: {
                      role: "rider",
                      isActive: true,
                      roleUpdatedAt: now,
                    },
                  },
                  { session },
                );

                if (userResult.matchedCount !== 1) {
                  throw new Error("USER_NOT_FOUND");
                }
              }
            });
          } finally {
            await session.endSession();
          }

          return res.status(200).send({
            success: true,
            message:
              status === "approved"
                ? "Rider approved and user role updated."
                : "Rider application rejected.",
          });
        } catch (error) {
          if (error.message === "APPLICATION_ALREADY_REVIEWED") {
            return res.status(409).send({
              message: "Application has already been reviewed.",
            });
          }

          console.error("Rider approval error:", error);

          return res.status(500).send({
            message: "Failed to update rider application.",
          });
        }
      },
    );

    app.post("/users", async (req, res) => {
      const email = req.body.email;
      const userExist = await usersCollection.findOne({ email });
      if (userExist) {
        // update last login as well later
        return res
          .status(200)
          .send({ message: "user already exists", inserted: false });
      }
      const user = req.body;
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    // Test route
    app.get("/", (req, res) => {
      res.send("Zap Shift Server is Running!");
    });

    // app.get("/parcels", async(req, res)=>{
    //     const parcels = await parcelCollection.find().toArray();
    //     res.send(parcels);
    // });

    // parcels api
    app.get("/parcels", verifyFBToken, async (req, res) => {
      try {
        const email = req.query.email;

        const query = email ? { createdByEmail: email } : {};

        const parcels = await parcelCollection
          .find(query)
          .sort({ createdAt: -1 })
          .toArray();

        res.send(parcels);
      } catch (error) {
        console.error("Failed to fetch parcels:", error);

        res.status(500).send({
          message: "Failed to fetch parcels",
        });
      }
    });

    // Get a single parcel by ID
    app.get("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({
            message: "Invalid parcel ID",
          });
        }

        const parcel = await parcelCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!parcel) {
          return res.status(404).send({
            message: "Parcel not found",
          });
        }

        res.send(parcel);
      } catch (error) {
        console.error("Failed to fetch parcel:", error);

        res.status(500).send({
          message: "Failed to fetch parcel",
        });
      }
    });

    // User payment history
    app.get("/payments", verifyFBToken, async (req, res) => {
      // console.log('headers in payment', req.headers);
      try {
        const email = req.query.email;
        console.log("decoded", req.decoded);

        if (req.decoded.email !== email) {
          return res.status(403).send({ message: "forbidden access" });
        }

        if (!email) {
          return res.status(400).send({
            message: "Email is required",
          });
        }

        const payments = await paymentCollection
          .find({ userEmail: email })
          .sort({ paidAt: -1, _id: -1 })
          .toArray();

        res.send(payments);
      } catch (error) {
        console.error(error);
        res.status(500).send({
          message: "Failed to load payment history",
        });
      }
    });

    const trackingStatuses = [
      "parcel_created",
      "picked_up",
      "in_transit",
      "out_for_delivery",
      "delivered",
      "delivery_failed",
      "returned",
      "cancelled",
    ];

    app.post("/tracking", async (req, res) => {
      try {
        const { trackingId, status, message, location } = req.body;

        if (
          !trackingId ||
          !trackingStatuses.includes(status) ||
          typeof message !== "string" ||
          !message.trim() ||
          typeof location !== "string"
        ) {
          return res.status(400).send({
            message: "Invalid tracking information",
          });
        }

        const parcel = await parcelCollection.findOne({
          trackingId,
        });

        if (!parcel) {
          return res.status(404).send({
            message: "Parcel not found",
          });
        }

        const trackingUpdate = {
          parcelId: parcel._id,
          trackingId: parcel.trackingId,
          status,
          message: message.trim(),
          location: location.trim(),
          timestamp: new Date(),
        };

        const result = await trackingCollection.insertOne(trackingUpdate);

        res.status(201).send({
          insertedId: result.insertedId,
          trackingUpdate,
        });
      } catch (error) {
        console.error("Tracking update error:", error);

        res.status(500).send({
          message: "Failed to add tracking update",
        });
      }
    });

    // find individual tracking

    app.get("/tracking/:trackingId", async (req, res) => {
      try {
        const trackingId = req.params.trackingId.trim().toUpperCase();

        const parcel = await parcelCollection.findOne(
          { trackingId },
          {
            projection: {
              _id: 0,
              trackingId: 1,
              status: 1,
              trackingHistory: 1,
            },
          },
        );

        if (!parcel) {
          return res.status(404).send({
            message: "Tracking ID not found",
          });
        }

        const allowedStatuses = new Set([
          "pending",
          "payment-completed",
          "rider-assigned",
          "rider_assigned",
          "in-transit",
          "in_transit",
          "delivered",
          "serveice_center_delivered",
          "service_center_delivered",
        ]);

        const history = (parcel.trackingHistory || [])
          .filter((event) => allowedStatuses.has(event.status))
          .map((event) => ({
            status: event.status,
            message: {
              pending: "Parcel request submitted",
              "payment-completed": "Payment completed",
              "rider-assigned": "Rider assigned",
              rider_assigned: "Rider assigned",
              "in-transit": "Parcel picked up",
              in_transit: "Parcel picked up",
              delivered: "Parcel delivered",
              serveice_center_delivered: "Delivered to service center",
              service_center_delivered: "Delivered to service center",
            }[event.status],
            timestamp: event.timestamp,
          }))
          .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        res.send({
          trackingId: parcel.trackingId,
          currentStatus: parcel.status,
          latestUpdate: history[0] || null,
          history,
        });
      } catch (error) {
        console.error("Tracking fetch error:", error);

        res.status(500).send({
          message: "Failed to fetch tracking information",
        });
      }
    });

    // app.get("/tracking/:trackingId", async (req, res) => {
    //   try {
    //     const { trackingId } = req.params;

    //     const trackingHistory = await trackingCollection
    //       .find(
    //         { trackingId },
    //         {
    //           projection: {
    //             trackingId: 1,
    //             status: 1,
    //             message: 1,
    //             location: 1,
    //             timestamp: 1,
    //           },
    //         },
    //       )
    //       .sort({ timestamp: -1, _id: -1 })
    //       .toArray();

    //     if (trackingHistory.length === 0) {
    //       return res.status(404).send({
    //         message: "Tracking ID not found",
    //       });
    //     }

    //     res.send({
    //       trackingId,
    //       currentStatus: trackingHistory[0].status,
    //       latestUpdate: trackingHistory[0],
    //       history: trackingHistory,
    //     });
    //   } catch (error) {
    //     console.error("Tracking fetch error:", error);

    //     res.status(500).send({
    //       message: "Failed to fetch tracking information",
    //     });
    //   }
    // });

    // search api without loading everybody
    app.get(
      "/admin/users/search",
      verifyFBToken,
      // verifyAdmin,
      async (req, res) => {
        try {
          const search = String(req.query.search || "").trim();
          const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
          const limit = 10;

          if (search.length < 2 || search.length > 100) {
            return res.status(400).send({
              message: "Search must contain between 2 and 100 characters.",
            });
          }

          if (!Number.isSafeInteger(page) || page > 10000) {
            return res.status(400).send({
              message: "Invalid page number.",
            });
          }

          const escapedSearch = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

          const query = {
            $or: [
              {
                name: {
                  $regex: `^${escapedSearch}`,
                  $options: "i",
                },
              },
              {
                email: {
                  $regex: `^${escapedSearch}`,
                  $options: "i",
                },
              },
            ],
          };

          const [users, total] = await Promise.all([
            usersCollection
              .find(query)
              .project({
                name: 1,
                email: 1,
                role: 1,
                createdAt: 1,
                created_at: 1,
                photoURL: 1,
              })
              .sort({ createdAt: -1, _id: -1 })
              .skip((page - 1) * limit)
              .limit(limit)
              .toArray(),

            usersCollection.countDocuments(query),
          ]);

          res.send({
            users,
            total,
            page,
            totalPages: Math.ceil(total / limit),
          });
        } catch (error) {
          console.error("User search error:", error);
          res.status(500).send({
            message: "Failed to search users.",
          });
        }
      },
    );

    app.get("/public/track/:trackingId", async (req, res) => {
      try {
        const trackingId = req.params.trackingId.trim().toUpperCase();

        // Validate tracking ID
        const trackingIdPattern = /^ZAP-\d{8}-[A-F0-9]{8}$/;

        if (!trackingIdPattern.test(trackingId)) {
          return res.status(400).send({
            message: "Invalid tracking ID format",
          });
        }

        // Find parcel
        const parcel = await parcelCollection.findOne(
          { trackingId },
          {
            projection: {
              trackingId: 1,
              status: 1,
              paymentStatus: 1,
              trackingHistory: 1,
              createdAt: 1,
              paidAt: 1,
              assignedAt: 1,
              pickedUpAt: 1,
              deliveredAt: 1,
              serviceCenterDeliveredAt: 1,
            },
          },
        );

        if (!parcel) {
          return res.status(404).send({
            message: "No parcel found with this tracking ID",
          });
        }

        // Normalize old and new status names
        const normalizeStatus = (status) => {
          const aliases = {
            rider_assigned: "rider-assigned",
            in_transit: "in-transit",
            serveice_center_delivered: "service_center_delivered",
          };

          return aliases[status] || status;
        };

        // Public-safe milestone descriptions
        const descriptions = {
          pending: "Parcel request submitted",
          "payment-completed": "Payment completed",
          "rider-assigned": "A rider has been assigned",
          "in-transit": "Parcel picked up by the rider",
          delivered: "Parcel delivered successfully",
          service_center_delivered: "Parcel delivered to the service center",
        };

        // Return only approved public tracking events
        const trackingHistory = (parcel.trackingHistory || [])
          .map((event) => {
            const status = normalizeStatus(event.status);

            if (!descriptions[status]) return null;

            return {
              status,
              description: descriptions[status],
              timestamp: event.timestamp,
            };
          })
          .filter(Boolean);

        // Determine the five completed milestones.
        // Older parcels may not have a payment event.
        const completedStatuses = new Set(
          trackingHistory.map((event) => event.status),
        );

        if (parcel.paymentStatus === "paid") {
          completedStatuses.add("payment-completed");
        }

        const currentStatus = normalizeStatus(parcel.status);

        if (currentStatus === "rider-assigned") {
          completedStatuses.add("rider-assigned");
        }

        if (currentStatus === "in-transit") {
          completedStatuses.add("in-transit");
        }

        if (
          currentStatus === "delivered" ||
          currentStatus === "service_center_delivered"
        ) {
          completedStatuses.add(currentStatus);
        }

        const milestones = [
          {
            status: "pending",
            label: "Parcel Submitted",
            completed: completedStatuses.has("pending"),
            timestamp:
              trackingHistory.find((event) => event.status === "pending")
                ?.timestamp ||
              parcel.createdAt ||
              null,
          },
          {
            status: "payment-completed",
            label: "Payment Completed",
            completed: completedStatuses.has("payment-completed"),
            timestamp:
              trackingHistory.find(
                (event) => event.status === "payment-completed",
              )?.timestamp ||
              parcel.paidAt ||
              null,
          },
          {
            status: "rider-assigned",
            label: "Rider Assigned",
            completed: completedStatuses.has("rider-assigned"),
            timestamp:
              trackingHistory.find((event) => event.status === "rider-assigned")
                ?.timestamp ||
              parcel.assignedAt ||
              null,
          },
          {
            status: "in-transit",
            label: "Parcel Picked Up",
            completed: completedStatuses.has("in-transit"),
            timestamp:
              trackingHistory.find((event) => event.status === "in-transit")
                ?.timestamp ||
              parcel.pickedUpAt ||
              null,
          },
          {
            status: "delivered",
            label: "Parcel Delivered",
            completed:
              completedStatuses.has("delivered") ||
              completedStatuses.has("service_center_delivered"),
            timestamp:
              trackingHistory.find((event) =>
                ["delivered", "service_center_delivered"].includes(
                  event.status,
                ),
              )?.timestamp ||
              parcel.deliveredAt ||
              parcel.serviceCenterDeliveredAt ||
              null,
          },
        ];

        res.send({
          trackingId: parcel.trackingId,
          currentStatus,
          milestones,
          trackingHistory,
        });
      } catch (error) {
        console.error("Public tracking error:", error);

        res.status(500).send({
          message: "Failed to retrieve parcel tracking",
        });
      }
    });

    // ? get role from email
    app.get("/users/role", verifyFBToken, async (req, res) => {
      try {
        const email = String(req.query.email || "")
          .trim()
          .toLowerCase();

        if (!email) {
          return res.status(400).send({
            message: "Email is required",
          });
        }

        // Prevent users from checking another user's role
        if (req.decoded.email?.toLowerCase() !== email) {
          return res.status(403).send({
            message: "Forbidden access",
          });
        }

        const user = await usersCollection.findOne(
          { email },
          { projection: { role: 1, _id: 0 } },
        );

        if (!user) {
          return res.status(404).send({
            message: "User not found",
          });
        }

        res.send({
          role: user.role || "user",
        });
      } catch (error) {
        console.error("Failed to fetch user role:", error);

        res.status(500).send({
          message: "Failed to fetch user role",
        });
      }
    });

    //? promote or demote a user
    app.patch(
      "/admin/users/:id/role",
      verifyFBToken,
      verifyAdmin,
      // verifyAdmin,
      async (req, res) => {
        try {
          const { id } = req.params;
          const { role } = req.body;

          if (!ObjectId.isValid(id)) {
            return res.status(400).send({
              message: "Invalid user ID.",
            });
          }

          if (!["admin", "user"].includes(role)) {
            return res.status(400).send({
              message: "Invalid role.",
            });
          }

          const targetUser = await usersCollection.findOne({
            _id: new ObjectId(id),
          });

          if (!targetUser) {
            return res.status(404).send({
              message: "User not found.",
            });
          }

          // Prevent an admin from removing their own privileges
          if (targetUser.firebaseUid === req.decoded.uid && role !== "admin") {
            return res.status(403).send({
              message: "You cannot remove your own admin role.",
            });
          }

          // Do not accidentally convert riders into customers
          if (role === "user" && targetUser.role !== "admin") {
            return res.status(400).send({
              message: "Only admins can be demoted through this route.",
            });
          }

          // Restore the previous role if one was saved.
          const nextRole =
            role === "admin"
              ? "admin"
              : ["user", "rider"].includes(targetUser.previousRole)
                ? targetUser.previousRole
                : "user";

          const update = {
            $set: {
              role: nextRole,
              roleUpdatedAt: new Date(),
              roleUpdatedBy: req.decoded.uid,
            },
          };

          if (role === "admin" && targetUser.role !== "admin") {
            update.$set.previousRole = targetUser.role || "user";
          }

          if (role !== "admin") {
            update.$unset = { previousRole: "" };
          }

          const result = await usersCollection.updateOne(
            { _id: targetUser._id, role: targetUser.role },
            update,
          );

          if (result.matchedCount !== 1) {
            return res.status(409).send({
              message: "User role changed. Please refresh and try again.",
            });
          }

          res.send({
            success: true,
            message:
              role === "admin"
                ? "User promoted to admin successfully."
                : "Admin privileges removed successfully.",
            role: nextRole,
          });
        } catch (error) {
          console.error("Role update error:", error);

          res.status(500).send({
            message: "Failed to update user role.",
          });
        }
      },
    );

    // Admin payment history
    app.get("/admin/payments", async (req, res) => {
      try {
        const payments = await paymentCollection
          .find()
          .sort({ paidAt: -1, _id: -1 })
          .toArray();

        res.send(payments);
      } catch (error) {
        console.error(error);
        res.status(500).send({
          message: "Failed to load all payments",
        });
      }
    });

    // Save a parcel
    // app.post("/parcels", async (req, res) => {
    //   try {
    //     const parcel = req.body;

    //     const result = await parcelCollection.insertOne(parcel);
    //     await trackingCollection.insertOne({
    //       parcelId: result.insertedId,
    //       trackingId: parcel.trackingId,
    //       status: "parcel_created",
    //       message: "Parcel booking created successfully",
    //       location: parcel.senderRegion || "",
    //       timestamp: new Date(),
    //     });

    //     res.status(201).send(result);
    //   } catch (error) {
    //     console.error("Parcel insert failed:", error);
    //     res.status(500).send({
    //       message: "Failed to save parcel",
    //     });
    //   }
    // });
    app.post("/parcels", async (req, res) => {
      try {
        const parcel = req.body;
        const now = new Date();

        const newParcel = {
          ...parcel,

          // Initial parcel status
          status: "pending",
          paymentStatus: "unpaid",
          createdAt: now,

          // Tracking history
          trackingHistory: [
            {
              status: "pending",
              description: "Parcel request submitted successfully",
              timestamp: now,
            },
          ],
        };

        const result = await parcelCollection.insertOne(newParcel);

        res.status(201).send({
          acknowledged: result.acknowledged,
          insertedId: result.insertedId,
          trackingId: newParcel.trackingId,
        });
      } catch (error) {
        console.error("Parcel insert failed:", error);

        res.status(500).send({
          message: "Failed to save parcel",
        });
      }
    });

    app.delete("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({
            message: "Invalid parcel ID",
          });
        }

        const result = await parcelCollection.deleteOne({
          _id: new ObjectId(id),
        });

        res.send(result);
      } catch (error) {
        console.error("Failed to delete parcel:", error);

        res.status(500).send({
          message: "Failed to delete parcel",
        });
      }
    });

    app.patch(
      "/admin/parcels/:parcelId/assign-rider",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const { parcelId } = req.params;
        const { riderId } = req.body;

        if (!ObjectId.isValid(parcelId) || !ObjectId.isValid(riderId)) {
          return res.status(400).send({
            message: "Invalid parcel or rider ID",
          });
        }

        const session = client.startSession();

        try {
          await session.withTransaction(async () => {
            // 1. Find parcel
            const parcel = await parcelCollection.findOne(
              { _id: new ObjectId(parcelId) },
              { session },
            );

            if (!parcel) {
              throw new Error("Parcel not found");
            }

            const latestStatus = parcel.trackingHistory?.at(-1)?.status;

            if (
              parcel.paymentStatus !== "paid" ||
              parcel.status !== "pending" ||
              latestStatus !== "pending"
            ) {
              throw new Error("Parcel is not available for assignment");
            }

            // 2. Find approved rider
            const rider = await riderApplicationsCollection.findOne(
              {
                _id: new ObjectId(riderId),
                status: "approved",
              },
              { session },
            );

            if (!rider) {
              throw new Error("Approved rider not found");
            }

            // 3. Verify user role
            const riderUser = await usersCollection.findOne(
              {
                email: rider.email,
                role: "rider",
              },
              { session },
            );

            if (!riderUser) {
              throw new Error("User is not an active rider");
            }

            // 4. Verify province
            const normalize = (value) =>
              String(value ?? "")
                .trim()
                .toLowerCase();

            if (normalize(parcel.receiverRegion) !== normalize(rider.region)) {
              throw new Error("Rider and delivery provinces do not match");
            }

            // 5. Check rider availability
            if (rider.workStatus === "in-delivery") {
              throw new Error("This rider is already handling a delivery");
            }

            const now = new Date();
            const timestamp = now.toISOString();

            // 6. Reserve rider
            const riderResult = await riderApplicationsCollection.updateOne(
              {
                _id: rider._id,
                status: "approved",
                workStatus: { $ne: "in-delivery" },
              },
              {
                $set: {
                  workStatus: "in-delivery",
                  currentParcelId: parcel._id,
                  workStatusUpdatedAt: now,
                },
              },
              { session },
            );

            if (riderResult.modifiedCount !== 1) {
              throw new Error("Rider is no longer available");
            }

            // 7. Assign parcel
            const parcelResult = await parcelCollection.updateOne(
              {
                _id: parcel._id,
                paymentStatus: "paid",
                status: "pending",
                $expr: {
                  $eq: [
                    {
                      $arrayElemAt: ["$trackingHistory.status", -1],
                    },
                    "pending",
                  ],
                },
              },
              {
                $set: {
                  status: "rider-assigned",

                  // NEW FIELD
                  assigned_rider_email: normalize(rider.email),

                  assignedRider: {
                    riderApplicationId: rider._id,
                    firebaseUid: rider.firebaseUid,
                    name: rider.name,
                    email: rider.email,
                    phone: rider.phone,
                    region: rider.region,
                    city: rider.city,
                  },

                  assignedAt: now,
                },

                $push: {
                  trackingHistory: {
                    status: "rider-assigned",
                    description: "Parcel assigned to a delivery rider",
                    timestamp,
                  },
                },
              },
              { session },
            );

            if (parcelResult.modifiedCount !== 1) {
              throw new Error("Parcel is no longer available");
            }
          });

          res.send({
            success: true,
            message: "Rider assigned successfully",
          });
        } catch (error) {
          console.error("Assign rider error:", error);

          res.status(409).send({
            message: error.message || "Assignment failed",
          });
        } finally {
          await session.endSession();
        }
      },
    );

    app.get(
      "/rider/pending-deliveries",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        try {
          const riderEmail = req.decoded.email?.trim().toLowerCase();

          if (!riderEmail) {
            return res.status(401).send({
              message: "Rider email not found",
            });
          }

          // Verify that the user is a rider
          const riderUser = await usersCollection.findOne({
            email: riderEmail,
            role: "rider",
          });

          if (!riderUser) {
            return res.status(403).send({
              message: "Rider access only",
            });
          }

          const query = {
            paymentStatus: "paid",

            status: {
              $in: [
                "rider-assigned",
                "in-transit",

                // Support underscore versions if present
                "rider_assigned",
                "in_transit",
              ],
            },

            $or: [
              {
                assigned_rider_email: riderEmail,
              },
              {
                "assignedRider.email": riderEmail,
              },
            ],
          };

          const parcels = await parcelCollection
            .find(query)
            .sort({ assignedAt: -1 })
            .toArray();

          res.send(parcels);
        } catch (error) {
          console.error("Pending deliveries error:", error);

          res.status(500).send({
            message: "Failed to load pending deliveries",
          });
        }
      },
    );

    app.get("/rider/my-earnings", verifyFBToken, async (req, res) => {
      try {
        const riderEmail = req.decoded.email?.trim().toLowerCase();

        const riderUid = req.decoded.uid;

        if (!riderEmail || !riderUid) {
          return res.status(401).send({
            message: "Authentication required",
          });
        }

        const riderUser = await usersCollection.findOne({
          email: riderEmail,
          role: "rider",
        });

        if (!riderUser) {
          return res.status(403).send({
            message: "Rider access only",
          });
        }

        const completedStatuses = [
          "delivered",
          "serveice_center_delivered",
          "service_center_delivered",
        ];

        const parcels = await parcelCollection
          .find({
            status: { $in: completedStatuses },
            paymentStatus: "paid",
            "assignedRider.firebaseUid": riderUid,
          })
          .toArray();

        const parcelIds = parcels.map((p) => p._id);

        const payouts = parcelIds.length
          ? await riderPayoutCollection
              .find({
                parcelId: { $in: parcelIds },
                riderUid,
              })
              .toArray()
          : [];

        const payoutMap = new Map(payouts.map((p) => [String(p.parcelId), p]));

        const calculateEarningsInCents = (parcel) => {
          if (parcel.parcelType === "document") {
            const fee = Number(parcel.deliveryCost);
            const feeCents = Math.round(fee * 100);

            if (!Number.isSafeInteger(feeCents) || feeCents < 0) {
              throw new Error("Invalid document delivery fee");
            }

            return Math.round(feeCents * 0.08);
          }

          if (parcel.parcelType === "non-document") {
            const weight = Number(parcel.parcelWeight);

            if (!Number.isFinite(weight) || weight <= 0) {
              throw new Error("Invalid parcel weight");
            }

            return Math.round(weight * 1000);
          }

          throw new Error("Unsupported parcel type");
        };

        const getCompletionDate = (parcel) => {
          if (parcel.deliveredAt) {
            return parcel.deliveredAt;
          }

          if (parcel.serviceCenterDeliveredAt) {
            return parcel.serviceCenterDeliveredAt;
          }

          const event = [...(parcel.trackingHistory || [])]
            .reverse()
            .find((item) => completedStatuses.includes(item.status));

          return event?.timestamp || null;
        };

        const deliveries = parcels.map((parcel) => {
          const payout = payoutMap.get(String(parcel._id));

          // Preserve the amount recorded when cash-out
          // was requested, even if rates change later.
          const earningsInCents =
            payout?.amountInCents ??
            parcel.riderEarningsInCents ??
            calculateEarningsInCents(parcel);

          const payoutStatus =
            payout?.status ?? parcel.riderPayoutStatus ?? "available";

          return {
            parcelId: String(parcel._id),
            trackingId: parcel.trackingId,
            parcelTitle: parcel.parcelTitle,
            parcelType: parcel.parcelType,
            earningsInCents,
            payoutStatus,
            completedAt: getCompletionDate(parcel),
            requestedAt: payout?.requestedAt ?? null,
            paidAt: payout?.paidAt ?? null,
          };
        });

        const sumByStatus = (statuses) =>
          deliveries
            .filter((d) => statuses.includes(d.payoutStatus))
            .reduce((sum, d) => sum + d.earningsInCents, 0);

        const totalEarnedInCents = deliveries.reduce(
          (sum, d) => sum + d.earningsInCents,
          0,
        );

        const totalCashedInCents = sumByStatus(["paid"]);

        const totalPendingInCents = sumByStatus([
          "requested",
          "approved",
          "processing",
        ]);

        const availableInCents = sumByStatus(["available"]);

        res.send({
          currency: "CAD",
          summary: {
            completedDeliveries: deliveries.length,
            totalEarnedInCents,
            totalCashedInCents,
            totalPendingInCents,
            availableInCents,
          },
          deliveries: deliveries.sort(
            (a, b) =>
              new Date(b.completedAt || 0) - new Date(a.completedAt || 0),
          ),
        });
      } catch (error) {
        console.error("My earnings error:", error);

        res.status(500).send({
          message: "Failed to load rider earnings",
        });
      }
    });

    app.post("/create-payment-intent", verifyFBToken, async (req, res) => {
      try {
        const { parcelId } = req.body;

        if (!ObjectId.isValid(parcelId)) {
          return res.status(400).send({
            message: "Invalid parcel ID",
          });
        }

        const parcel = await parcelCollection.findOne({
          _id: new ObjectId(parcelId),
        });

        if (!parcel) {
          return res.status(404).send({
            message: "Parcel not found",
          });
        }

        // Check parcel ownership
        if (parcel.createdByUid !== req.decoded.uid) {
          return res.status(403).send({
            message: "Forbidden access",
          });
        }

        if (parcel.paymentStatus === "paid") {
          return res.status(409).send({
            message: "Parcel already paid",
          });
        }

        const amountInCents = Math.round(Number(parcel.deliveryCost) * 100);

        if (!Number.isSafeInteger(amountInCents) || amountInCents <= 0) {
          return res.status(400).send({
            message: "Invalid delivery cost",
          });
        }

        // Reuse a previously created PaymentIntent
        let paymentIntent;

        if (parcel.pendingPaymentIntentId) {
          const existing = await stripe.paymentIntents.retrieve(
            parcel.pendingPaymentIntentId,
          );

          if (
            existing.metadata?.parcelId !== parcelId ||
            existing.amount !== amountInCents ||
            existing.currency !== "cad"
          ) {
            return res.status(409).send({
              message: "Existing payment details do not match",
            });
          }

          if (existing.status === "succeeded") {
            return res.status(409).send({
              message:
                "Payment already succeeded. Please verify the existing payment.",
              paymentIntentId: existing.id,
            });
          }

          if (existing.status === "processing") {
            return res.status(409).send({
              message: "Payment is still processing",
            });
          }

          if (existing.status !== "canceled") {
            paymentIntent = existing;
          }
        }

        if (!paymentIntent) {
          paymentIntent = await stripe.paymentIntents.create({
            amount: amountInCents,
            currency: "cad",

            automatic_payment_methods: {
              enabled: true,
              allow_redirects: "never",
            },

            metadata: {
              parcelId: parcel._id.toString(),
              trackingId: String(parcel.trackingId ?? ""),
            },
          });

          await parcelCollection.updateOne(
            {
              _id: parcel._id,
              paymentStatus: { $ne: "paid" },
            },
            {
              $set: {
                pendingPaymentIntentId: paymentIntent.id,
              },
            },
          );
        }

        res.json({
          clientSecret: paymentIntent.client_secret,
        });
      } catch (error) {
        console.error("PaymentIntent error:", error);

        res.status(500).send({
          message: "Failed to create payment intent",
        });
      }
    });

    app.get(
      "/admin/dashboard/parcel-status",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const result = await parcelCollection
            .aggregate([
              {
                $group: {
                  _id: "$status",
                  count: { $sum: 1 },
                },
              },
            ])
            .toArray();

          const counts = {
            pending: 0,
            "rider-assigned": 0,
            "in-transit": 0,
            delivered: 0,
          };

          result.forEach((item) => {
            if (Object.hasOwn(counts, item._id)) {
              counts[item._id] = item.count;
            }
          });

          res.json(counts);
        } catch (error) {
          console.error("Parcel status error:", error);

          res.status(500).json({
            message: "Failed to load parcel statuses",
          });
        }
      },
    );

    app.get(
      "/admin/dashboard/recent-parcels",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const limit = Math.min(
            Math.max(Number.parseInt(req.query.limit, 10) || 10, 1),
            50,
          );

          const parcels = await parcelCollection
            .find(
              {},
              {
                projection: {
                  trackingId: 1,
                  parcelTitle: 1,
                  senderRegion: 1,
                  receiverRegion: 1,
                  deliveryCost: 1,
                  paymentStatus: 1,
                  status: 1,
                  createdAt: 1,
                },
              },
            )
            .sort({ createdAt: -1 })
            .limit(limit)
            .toArray();

          res.json(parcels);
        } catch (error) {
          console.error("Recent parcels error:", error);

          res.status(500).json({
            message: "Failed to load recent parcels",
          });
        }
      },
    );

    app.patch(
      "/rider/parcels/:parcelId/status",
      verifyFBToken,
      async (req, res) => {
        const { parcelId } = req.params;
        const { action } = req.body;

        if (!ObjectId.isValid(parcelId)) {
          return res.status(400).send({
            message: "Invalid parcel ID",
          });
        }

        if (!["pickup", "deliver"].includes(action)) {
          return res.status(400).send({
            message: "Invalid delivery action",
          });
        }

        const riderEmail = req.decoded.email?.trim().toLowerCase();
        const riderUid = req.decoded.uid;

        if (!riderEmail || !riderUid) {
          return res.status(401).send({
            message: "Authentication required",
          });
        }

        const session = client.startSession();

        try {
          let updatedStatus;

          await session.withTransaction(async () => {
            // Verify rider role
            const riderUser = await usersCollection.findOne(
              {
                email: riderEmail,
                role: "rider",
              },
              { session },
            );

            if (!riderUser) {
              throw new Error("Rider access only");
            }

            // Find parcel belonging to this rider
            const parcel = await parcelCollection.findOne(
              {
                _id: new ObjectId(parcelId),
                paymentStatus: "paid",
                "assignedRider.firebaseUid": riderUid,
              },
              { session },
            );

            if (!parcel) {
              throw new Error("Parcel not found or not assigned to you");
            }

            const currentStatus = parcel.status;

            const assignedStatuses = ["rider-assigned", "rider_assigned"];

            const transitStatuses = ["in-transit", "in_transit"];

            const expectedStatuses =
              action === "pickup" ? assignedStatuses : transitStatuses;

            if (!expectedStatuses.includes(currentStatus)) {
              throw new Error(
                "This action is not allowed for the current status",
              );
            }

            const latestStatus = parcel.trackingHistory?.at(-1)?.status;

            if (latestStatus !== currentStatus) {
              throw new Error("Parcel tracking status is inconsistent");
            }

            updatedStatus = action === "pickup" ? "in-transit" : "delivered";

            const now = new Date();

            const description =
              action === "pickup"
                ? "Parcel picked up by the assigned rider"
                : "Parcel successfully delivered to the receiver";

            // Update parcel and tracking history
            const parcelResult = await parcelCollection.updateOne(
              {
                _id: parcel._id,
                status: { $in: expectedStatuses },
                "assignedRider.firebaseUid": riderUid,
                $expr: {
                  $eq: [
                    {
                      $arrayElemAt: ["$trackingHistory.status", -1],
                    },
                    currentStatus,
                  ],
                },
              },
              {
                $set: {
                  status: updatedStatus,
                  statusUpdatedAt: now,
                  ...(action === "deliver"
                    ? { deliveredAt: now }
                    : { pickedUpAt: now }),
                },
                $push: {
                  trackingHistory: {
                    status: updatedStatus,
                    description,
                    timestamp: now.toISOString(),
                  },
                },
              },
              { session },
            );

            if (parcelResult.modifiedCount !== 1) {
              throw new Error("Parcel status could not be updated");
            }

            // Release rider only after successful delivery
            if (action === "deliver") {
              const riderResult = await riderApplicationsCollection.updateOne(
                {
                  _id: parcel.assignedRider.riderApplicationId,
                  firebaseUid: riderUid,
                  workStatus: "in-delivery",
                  currentParcelId: parcel._id,
                },
                {
                  $set: {
                    workStatus: "available",
                    workStatusUpdatedAt: now,
                  },
                  $unset: {
                    currentParcelId: "",
                  },
                },
                { session },
              );

              if (riderResult.modifiedCount !== 1) {
                throw new Error("Could not release rider from delivery");
              }
            }
          });

          res.send({
            success: true,
            message:
              action === "pickup"
                ? "Parcel marked as picked up"
                : "Parcel marked as delivered",
            status: updatedStatus,
          });
        } catch (error) {
          console.error("Rider status update error:", error);

          res.status(409).send({
            message: error.message || "Status update failed",
          });
        } finally {
          await session.endSession();
        }
      },
    );

    app.get(
      "/admin/dashboard/summary",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const [
            totalParcels,
            deliveredParcels,
            inTransitParcels,
            revenueResult,
          ] = await Promise.all([
            parcelCollection.countDocuments(),

            parcelCollection.countDocuments({
              status: "delivered",
            }),

            parcelCollection.countDocuments({
              status: "in-transit",
            }),

            paymentCollection
              .aggregate([
                {
                  $match: {
                    status: "paid",
                  },
                },
                {
                  $group: {
                    _id: null,
                    total: { $sum: "$amount" },
                  },
                },
              ])
              .toArray(),
          ]);

          const totalRevenue = revenueResult[0]?.total ?? 0;

          res.status(200).json({
            totalParcels,
            totalRevenue,
            deliveredParcels,
            inTransitParcels,
          });
        } catch (error) {
          console.error("Dashboard summary error:", error);

          res.status(500).json({
            message: "Failed to load dashboard summary",
          });
        }
      },
    );

    app.get(
      "/admin/dashboard/analytics",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const days = Number(req.query.days) === 30 ? 30 : 7;

          // UTC calendar-day boundaries
          const today = new Date();
          const startDate = new Date(
            Date.UTC(
              today.getUTCFullYear(),
              today.getUTCMonth(),
              today.getUTCDate() - (days - 1),
            ),
          );

          const endDate = new Date(
            Date.UTC(
              today.getUTCFullYear(),
              today.getUTCMonth(),
              today.getUTCDate() + 1,
            ),
          );

          // 1. Daily parcel counts
          const parcelData = await parcelCollection
            .aggregate([
              {
                $addFields: {
                  createdDate: {
                    $convert: {
                      input: "$createdAt",
                      to: "date",
                      onError: null,
                      onNull: null,
                    },
                  },
                },
              },
              {
                $match: {
                  createdDate: {
                    $gte: startDate,
                    $lt: endDate,
                  },
                },
              },
              {
                $group: {
                  _id: {
                    $dateToString: {
                      format: "%Y-%m-%d",
                      date: "$createdDate",
                      timezone: "UTC",
                    },
                  },
                  parcels: { $sum: 1 },
                },
              },
              { $sort: { _id: 1 } },
            ])
            .toArray();

          // 2. Daily successful payment revenue
          const revenueData = await paymentCollection
            .aggregate([
              {
                $match: {
                  status: "paid",
                },
              },
              {
                $addFields: {
                  paymentDate: {
                    $convert: {
                      input: "$paidAt",
                      to: "date",
                      onError: null,
                      onNull: null,
                    },
                  },
                },
              },
              {
                $match: {
                  paymentDate: {
                    $gte: startDate,
                    $lt: endDate,
                  },
                },
              },
              {
                $group: {
                  _id: {
                    $dateToString: {
                      format: "%Y-%m-%d",
                      date: "$paymentDate",
                      timezone: "UTC",
                    },
                  },
                  revenue: { $sum: "$amount" },
                },
              },
              { $sort: { _id: 1 } },
            ])
            .toArray();

          // 3. Combine and fill missing days with zero
          const parcelMap = new Map(
            parcelData.map((item) => [item._id, item.parcels]),
          );

          const revenueMap = new Map(
            revenueData.map((item) => [item._id, item.revenue]),
          );

          const analytics = [];

          for (let i = 0; i < days; i++) {
            const date = new Date(startDate);
            date.setUTCDate(startDate.getUTCDate() + i);

            const dateKey = date.toISOString().slice(0, 10);

            analytics.push({
              date: dateKey,
              parcels: parcelMap.get(dateKey) ?? 0,
              revenue: revenueMap.get(dateKey) ?? 0,
            });
          }

          res.status(200).json({
            days,
            analytics,
          });
        } catch (error) {
          console.error("Dashboard analytics error:", error);

          res.status(500).json({
            message: "Failed to load dashboard analytics",
          });
        }
      },
    );

    app.get(
      "/rider/completed-deliveries",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        try {
          // Get logged-in rider's email
          const riderEmail = req.decoded.email?.trim().toLowerCase();

          if (!riderEmail) {
            return res.status(401).send({
              message: "Rider email not found",
            });
          }

          // Verify rider role
          const riderUser = await usersCollection.findOne({
            email: riderEmail,
            role: "rider",
          });

          if (!riderUser) {
            return res.status(403).send({
              message: "Rider access only",
            });
          }

          // Find completed parcels assigned to this rider
          const query = {
            status: {
              $in: ["delivered", "serveice_center_delivered"],
            },

            $or: [
              { assigned_rider_email: riderEmail },

              // Support older parcel documents
              { "assignedRider.email": riderEmail },
            ],
          };

          const parcels = await parcelCollection
            .find(query)
            .sort({ deliveredAt: -1, assignedAt: -1 })
            .toArray();

          res.send(parcels);
        } catch (error) {
          console.error("Failed to fetch completed deliveries:", error);

          res.status(500).send({
            message: "Failed to fetch completed deliveries",
          });
        }
      },
    );

    app.patch(
      "/parcels/:parcelId/verify-payment",
      verifyFBToken,
      async (req, res) => {
        try {
          const { parcelId } = req.params;
          const { paymentIntentId } = req.body;

          if (
            !ObjectId.isValid(parcelId) ||
            typeof paymentIntentId !== "string" ||
            !paymentIntentId
          ) {
            return res.status(400).send({
              message: "Invalid payment information",
            });
          }

          const parcel = await parcelCollection.findOne({
            _id: new ObjectId(parcelId),
          });

          if (!parcel) {
            return res.status(404).send({
              message: "Parcel not found",
            });
          }

          // Verify parcel ownership
          if (parcel.createdByUid !== req.decoded.uid) {
            return res.status(403).send({
              message: "Forbidden access",
            });
          }

          // Verify payment directly with Stripe
          const paymentIntent =
            await stripe.paymentIntents.retrieve(paymentIntentId);

          if (paymentIntent.status !== "succeeded") {
            return res.status(400).send({
              message: "Payment has not succeeded",
            });
          }

          if (
            paymentIntent.metadata?.parcelId !== parcelId ||
            parcel.pendingPaymentIntentId !== paymentIntent.id
          ) {
            return res.status(400).send({
              message: "Payment does not belong to this parcel",
            });
          }

          const expectedAmount = Math.round(Number(parcel.deliveryCost) * 100);

          if (
            paymentIntent.amount !== expectedAmount ||
            paymentIntent.currency !== "cad"
          ) {
            return res.status(400).send({
              message: "Payment amount or currency mismatch",
            });
          }

          const paidAt = new Date();

          // Save payment history without duplicates
          await paymentCollection.updateOne(
            { paymentIntentId: paymentIntent.id },
            {
              $setOnInsert: {
                parcelId: parcel._id,
                trackingId: parcel.trackingId,
                userEmail: parcel.createdByEmail,
                amount: paymentIntent.amount / 100,
                currency: "CAD",
                paymentStatus: "paid",
                paymentIntentId: paymentIntent.id,
                paidAt,
              },
            },
            { upsert: true },
          );

          // Update the parcel's payment status
          await parcelCollection.updateOne(
            {
              _id: parcel._id,
              paymentStatus: { $ne: "paid" },
            },
            {
              $set: {
                paymentStatus: "paid",
                paidAt,
                paymentIntentId: paymentIntent.id,
              },
              $unset: {
                pendingPaymentIntentId: "",
              },
            },
          );

          res.send({
            success: true,
            message: "Payment verified and saved successfully",
          });
        } catch (error) {
          console.error("Payment verification error:", error);

          res.status(500).send({
            message: "Failed to verify payment",
          });
        }
      },
    );

    // Test MongoDB connection
    // await db.command({ ping: 1 });
    // console.log("Connected to MongoDB successfully!");

    app.listen(port, () => {
      console.log(`Zap Shift server running on port ${port}`);
    });
  } catch (error) {
    console.error("MongoDB connection failed:", error);
    process.exitCode = 1;
  }
}

run();
