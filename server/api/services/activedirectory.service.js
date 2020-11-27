import ActiveDirectory from "activedirectory";
import ActiveDirectoryError from "../utils/ActiveDirectoryError";
import log4js from "log4js";

const logger = log4js.getLogger("service.auth");

/**
 * @description Proposed setup:
 *                  /-> MapService
 * Request -> Proxy
 *                  \-> GeoServer
 *
 * 1. User's request goes to a Proxy. That proxy is the only component visible to the outside world.
 *    Neither MapService nor GeoServer are reachable directly by Request.
 * 2. Proxy authenticates the user. If authentication is successful, Proxy will add user's userPrincipalName
 *    value as the value of the "X-Control-Header" request header. The header's name is can be
 *    overridden in .env.
 * 3. MapService (i.e. this application) should be configured in such a way that it only allows
 *    requests from specified IPs (which should be the Proxy IP).
 *    Alternatively, it could allow
 *    requests from anywhere, but only respect the value of X-Control-Header if request comes
 *    from a specified IP.
 *
 * @class ActiveDirectoryService
 */
class ActiveDirectoryService {
  constructor() {
    if (process.env.AD_LOOKUP_ACTIVE !== "true") {
      logger.info(
        "AD_LOOKUP_ACTIVE is set to %o in .env. Not enabling ActiveDirectory authentication.",
        process.env.AD_LOOKUP_ACTIVE
      );
      return;
    }

    logger.trace("Initiating ActiveDirectoryService");

    if (
      process.env.AD_URL === undefined ||
      process.env.AD_BASE_DN === undefined ||
      process.env.AD_USERNAME === undefined ||
      process.env.AD_PASSWORD === undefined
    ) {
      throw new ActiveDirectoryError("Configuration missing");
    }

    // Initiate 3 local stores to cache the results from AD.
    // One will hold user details, the other will hold groups
    // per user.
    this._users = new Map();
    this._groups = new Set();
    this._groupsPerUser = new Map();

    // The main AD object that will handle communication
    this._ad = new ActiveDirectory(
      process.env.AD_URL,
      process.env.AD_BASE_DN,
      process.env.AD_USERNAME,
      process.env.AD_PASSWORD
    );

    this._trustedHeader = process.env.AD_TRUSTED_HEADER || "X-Control-Header";
  }

  /**
   * @summary Helper that makes it easy to see if AD auth is configured, and
   * in that case if user name can be trusted.
   *
   * @description Admin can configure AD authentication by setting certain flags in.env.
   * If those are set, we should extract user name from a request header, usually
   * X-Control-Header. However, if admin has specified a range of trusted IPs (which should
   * be done), the header's value will only be read if request comes from a trusted IP. Else
   * undefined will be returned, which will lead to errors.
   *
   * Please note that a special flag, AD_OVERRIDE_USER_WITH_VALUE, will override the value of
   * request header. Use it only for development and debugging purposes, NEVER in production.
   *
   * @param {*} req
   * @returns User as specified in configured request header or undefined if checks weren't met.
   * @memberof ActiveDirectoryService
   */
  getUserFromRequestHeader(req) {
    if (process.env.AD_LOOKUP_ACTIVE !== "true") {
      // If AD_LOOKUP_ACTIVE is anything else than "true", we don't care
      // about doing any username checks. Just return undefined as username.
      return undefined;
    } else {
      // AD authentication is active.
      //
      // First see if webmaster wants to override the header value (useful for developing and testing)
      if (
        process.env.AD_OVERRIDE_USER_WITH_VALUE !== undefined &&
        process.env.AD_OVERRIDE_USER_WITH_VALUE.trim().length !== 0
      ) {
        logger.warn(
          'AD_OVERRIDE_USER_WITH_VALUE is set in .env! Will use "%s" as user name for all AD functions. DON\'T USE THIS IN PRODUCTION!',
          process.env.AD_OVERRIDE_USER_WITH_VALUE
        );

        return process.env.AD_OVERRIDE_USER_WITH_VALUE;
      }

      // Now it's time to take care of the _real_ AD authentication!
      //
      // AD_LOOKUP_ACTIVE is "true" so let's find out a couple of things.
      // 1. Do we only accept requests from certain IPs? If so, check that
      // request comes from accepted IP. If not, abort.
      // 2. If we passed the first check (either because request comes from
      // accepted IP, or because we accept any IPs (dangerous!)) we can now
      // take care of finding out the user name. It will be read from a REQ
      // header.
      //
      // Implementation follows.

      // Step 1: See if the current req IP is within the accepted IPs range
      const requestComesFromAcceptedIP =
        process.env.AD_TRUSTED_PROXY_IPS === undefined || // If no IPs are specified, because variable isn't set,
        process.env.AD_TRUSTED_PROXY_IPS.trim().length === 0 || // or because it's an empty string, it means that we accept any IP (dangerous!).
        process.env.AD_TRUSTED_PROXY_IPS?.split(",").includes(req.ip); // Else, if specified, split on comma and see if IP exists in list

      // Abort if request comes from unaccepted IP range
      if (requestComesFromAcceptedIP === false) {
        const e = new Error(
          `[getUserFromRequestHeader] AD authentication does not allow requests from ${req.ip}. Aborting.`
        );
        logger.error(e.message);
        throw e;
      }

      // If we got this far, we've got through the check above. But we should ensure
      // that IP range really is configured - if not we should print an additional
      // warning in the log, so that admin is aware of this possible misconfiguration.
      if (
        process.env.AD_TRUSTED_PROXY_IPS === undefined ||
        process.env.AD_TRUSTED_PROXY_IPS.trim().length === 0
      ) {
        logger.warn(
          `[getUserFromRequestHeader] AD authentication is active but no IP range restriction is set in .env. 
                          ***This means that you accept the value of X-Control-Header from any request, which is potentially a huge security risk!***`
        );
      }

      logger.trace(
        `[getUserFromRequestHeader] Request from ${req.ip} accepted by AD`
      );

      // See which header we should be looking into
      const xControlHeader =
        process.env.AD_TRUSTED_HEADER || "X-Control-Header";

      // The user will only be set only if request comes from accepted IP.
      // Else, we'll send undefined as user parameter, which will in turn lead
      // to errors being thrown (if AD auth is required in .env)
      const user =
        (requestComesFromAcceptedIP && req.get(xControlHeader)) || undefined;
      logger.trace(
        "[getUserFromRequestHeader] Header %s has value: %o",
        process.env.AD_TRUSTED_HEADER,
        user
      );
      return user;
    }
  }

  async isUserValid(sAMAccountName) {
    logger.trace(
      "[isUserValid] Checking if %o is a valid user in AD",
      sAMAccountName
    );

    // Grab the user object from AD (or Users store, if already there)
    const user = await this.findUser(sAMAccountName);

    // We assume that the user is valid if it has the sAMAccountName property.
    // Invalid users, that have not been found in AD, will be set to empty objects,
    // so this should work in all cases (unless some AD lacks the sAMAccountName property).
    const isValid = Object.prototype.hasOwnProperty.call(
      user,
      "sAMAccountName"
    );
    logger.trace(
      "[isUserValid] %o is %sa valid user in AD",
      sAMAccountName,
      isValid ? "" : "NOT "
    );
    return isValid;
  }

  /**
   * @summary Entirely flush the local cache of users and groups and start over by fetching from AD.
   * @description We utilize a local caching mechanism in order to minimize the traffic to AD.
   * This means that if a request comes in, and user object doesn't exist, we ask AD for the user
   * and group details, and store them locally (in two Maps). When subsequential requests arrive,
   * we just look them up in the local cache.
   *
   * The implication of this is that if network administrators change a users group membership,
   * we don't have the latest updates (and won't even care about asking the AD for them, as the user
   * is already cached!).
   *
   * This method simply resets this cache which will make all requests to be fetched from AD again.
   *
   * @memberof ActiveDirectoryService
   */
  flushCache() {
    logger.trace("Flushing local cache");
    this._users.clear();
    this._groups.clear();
    this._groupsPerUser.clear();
  }

  /**
   * @summary Retrieve the user object from AD
   * @description The local store will be used to cache retrieved AD objects
   * in order to minimize requests to the AD. Requested user object is returned
   * if found, else null.
   *
   * @param {*} sAMAccountName
   * @returns {user} or empty object, if user not found
   * @memberof ActiveDirectoryService
   */
  async findUser(sAMAccountName) {
    try {
      // If anything else than String is supplied, it can't be a valid sAMAccountName
      if (typeof sAMAccountName !== "string") {
        throw new Error(
          `${sAMAccountName} is not a string, hence it can't be a valid user name sAMAccountName`
        );
      }

      sAMAccountName = sAMAccountName.trim();

      if (sAMAccountName.length === 0) {
        throw new Error("Empty string is not a valid sAMAccountName");
      }

      // Check if user entry already exists in store
      if (!this._users.has(sAMAccountName)) {
        logger.trace("[findUser] Looking up %o in real AD", sAMAccountName);
        // If store didn't contain the requested user, get it from AD
        const user = await this._findUser(sAMAccountName);

        logger.trace(
          "[findUser] Saving %o in user store with value: \n%O",
          sAMAccountName,
          user
        );

        // Save the returned object to AD
        this._users.set(sAMAccountName, user);
      }

      return this._users.get(sAMAccountName);
    } catch (error) {
      logger.error("[findUser] %s", error.message);
      // Save to Users Store to prevent subsequential lookups - we already
      // know that this user doesn't exist.
      this._users.set(sAMAccountName, {});
      return {};
    }
  }

  async getGroupMembershipForUser(sAMAccountName) {
    try {
      // See if we've got results in store already
      let groups = this._groupsPerUser.get(sAMAccountName);
      if (groups !== undefined) {
        logger.trace(
          "[getGroupMembershipForUser] %o groups already found in groups-per-users store",
          sAMAccountName
        );
        return groups;
      }

      logger.trace(
        "[getGroupMembershipForUser] No entry for %o in the groups-per-users store yet. Populating…",
        sAMAccountName
      );

      // First, we need to translate the incoming sAMAcountName
      // to the longer userPrincipalName that is required by
      // _getGroupMembershipForUser(). To do that, we need to
      // grab it from user object.
      const { userPrincipalName } = await this.findUser(sAMAccountName);

      // Retrieve groups for user
      groups = await this._getGroupMembershipForUser(userPrincipalName);

      // We only care about the shortname (CN)
      groups = groups.map((g) => g.cn);

      logger.trace(
        "[getGroupMembershipForUser] Done. Setting groups-per-users store key %o to value: %O",
        sAMAccountName,
        groups
      );

      // Set in local store
      this._groupsPerUser.set(sAMAccountName, groups);
      return groups;
    } catch (error) {
      // If we didn't get groups, cache the empty result to eliminate subsequential requests
      this._groupsPerUser.set(sAMAccountName, []);
      logger.error(error.message);
      return [];
    }
  }

  async isUserMemberOf(sAMAccountName, groupCN) {
    try {
      // First some checks, so we don't get random results from the AD
      if (sAMAccountName === undefined)
        throw new ActiveDirectoryError(
          "Cannot lookup group membership for undefined user"
        );
      if (groupCN === undefined)
        throw new ActiveDirectoryError(
          "Cannot lookup membership if group isn't specified"
        );

      // If we haven't cached the requested user's groups yet…
      if (!this._groupsPerUser.has(sAMAccountName)) {
        logger.trace(
          "[isUserMemberOf] Can't find %o in groups-per-users store. Will need to populate.",
          sAMAccountName
        );
        // …let's cache them.
        await this.getGroupMembershipForUser(sAMAccountName);
      }

      // Now everything should be in store, see if user is member
      // of the specified group
      return this._groupsPerUser.get(sAMAccountName).includes(groupCN);
    } catch (error) {
      logger.error(error.message);
      // If an error was thrown above (e.g because user wasn't found
      // in AD), we return false (because a non-existing user isn't
      // a member of the specified group).
      return false;
    }
  }

  /**
   * @description Fetch an array of all available AD groups
   *
   * @returns {Array} AD groups
   * @memberof ActiveDirectoryService
   */
  async getAvailableADGroups() {
    try {
      // This is a bit of an expensive operation so we utilize a caching mechanism here too
      if (this._groups.size === 0) {
        // Looks as cache is empty, go on and ask the AD
        const groups = await this._findGroups();

        // Replace the cache with a new Set that…
        this._groups = new Set(groups.map((g) => g.cn)); // isn't the whole object, but rather only an array of CN properties
      }

      // Spread the Set into an Array, which is the expected output format
      return [...this._groups];
    } catch (error) {
      logger.error(error.message);
      return [];
    }
  }

  /**
   * @summary A useful admin method that will return the common groups for any users
   * TODO: Fix /admin so it makes use of this new method instead of the generic getAvailableADGroups().
   * @param {Array} users A list of users
   * @returns {Array} Groups that are common for all specified users
   * @memberof ActiveDirectoryService
   */
  async findCommonGroupsForUsers(users) {
    try {
      if (users.length < 1)
        throw new ActiveDirectoryError(
          "Can't find common groups if no users are supplied"
        );

      // Grab Promises that will contain all users' groups
      const promises = users.map((u) => this.getGroupMembershipForUser(u));

      // Wait for all promises to resolve
      const userGroups = await Promise.all(promises);

      // Reduce the arrays of groups to only include common items
      // (this is basically a multi-array intersection operation)
      const commonGroups = userGroups.reduce((a, b) =>
        a.filter((c) => b.includes(c))
      );

      return commonGroups;
    } catch (error) {
      logger.error(error.message);
      return [];
    }
  }

  _getGroupMembershipForUser(userPrincipalName) {
    return new Promise((resolve, reject) => {
      this._ad.getGroupMembershipForUser(userPrincipalName, function (
        err,
        groups
      ) {
        if (err) {
          reject(err);
        }

        if (!groups)
          reject(
            new ActiveDirectoryError(`User ${userPrincipalName} not found.`)
          );
        else resolve(groups);
      });
    });
  }

  _findUser(sAMAccountName) {
    return new Promise((resolve, reject) => {
      // Else, lookup and add answer to adStore
      this._ad.findUser(sAMAccountName, function (err, u) {
        if (err) {
          reject(err);
        }
        if (!u)
          reject(new ActiveDirectoryError(`User ${sAMAccountName} not found.`));
        resolve(u);
      });
    });
  }

  // Not needed, as we have another implementation that doesn't use the AD-method
  // _isUserMemberOf(user, group) {
  //   return new Promise((resolve, reject) => {
  //     // First check in this.adStore and easily resolve if found
  //     // resolve(true|false)

  //     // Else, lookup and add answer to adStore
  //     this._ad.isUserMemberOf(user, group, (err, isMember) => {
  //       if (err) {
  //         reject(err);
  //       }

  //       log.trace("isMember: ", isMember);
  //       resolve(isMember);
  //     });
  //   });
  // }

  _findGroups(query = "CN=*") {
    return new Promise((resolve, reject) => {
      // Else, lookup and add answer to adStore
      this._ad.findGroups(query, function (err, g) {
        if (err) {
          reject(err);
        }
        if (!g) reject(new ActiveDirectoryError(`Couldn't retrieve groups.`));
        resolve(g);
      });
    });
  }
}

export default new ActiveDirectoryService();